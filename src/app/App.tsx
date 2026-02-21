import { useState, useRef, useEffect } from 'react';
import { Upload, AlertCircle, CheckCircle, Loader2, Download, X } from 'lucide-react';

// Types
type ProcessingStatus = 'idle' | 'checking_queue' | 'queue_full_waiting' | 'queued' | 'uploading' | 'splitting' | 'adding_watermarks' | 'merging' | 'downloading' | 'finished' | 'error';

interface HistoryItem {
  id: string;
  timestamp: Date;
  originalName: string;
  watermarkedName: string;
  downloadUrl: string;
  downloadFailed: boolean;
  jobId?: string;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

interface QueueInfo {
  position: number;
  jobsAhead: number;
  estimatedWaitSeconds: number | null;
}

interface CheckSizeResponse {
  allowed: boolean;
  max_allowed_size: number;
  available_ram: number;
  message: string;
  queue_available: boolean;
  queue_message: string;
  retry_after_seconds: number | null;
  queue_count: number;
  active_jobs: number;
}

interface QueueWaitInfo {
  activeJobs: number;
  queueCount: number;
  retryAfterSeconds: number;
  countdownSeconds: number;
}

export default function App() {
  const [currentStage, setCurrentStage] = useState<'home' | 'processing'>('home');
  const [chunkSize, setChunkSize] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [homeErrorMessage, setHomeErrorMessage] = useState('');
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [usedColors, setUsedColors] = useState<Set<string>>(new Set());
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [showDownloadButton, setShowDownloadButton] = useState(false);
  const [showExpiryWarning, setShowExpiryWarning] = useState(false);
  const [queueInfo, setQueueInfo] = useState<QueueInfo | null>(null);
  const [queueWaitInfo, setQueueWaitInfo] = useState<QueueWaitInfo | null>(null);
  const [backendAwake, setBackendAwake] = useState(false);
  const [wakingBackend, setWakingBackend] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queueCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttemptRef = useRef<number>(0);

  // Use environment variable for API URL, fallback to localhost for development
  // In production (GitHub Pages), use the Render backend URL
  const API_BASE = import.meta.env.VITE_API_BASE_URL || 
    (import.meta.env.PROD ? 'https://watermarks-backend.onrender.com' : 'http://localhost:8000');

  // Wake up backend on component mount
  useEffect(() => {
    wakeUpBackend();
  }, []);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      // Clear all expiry timers
      history.forEach(item => {
        if (item.expiryTimer) {
          clearTimeout(item.expiryTimer);
        }
      });
      // Clear queue check intervals
      if (queueCheckIntervalRef.current) {
        clearInterval(queueCheckIntervalRef.current);
      }
      if (queueCheckTimeoutRef.current) {
        clearTimeout(queueCheckTimeoutRef.current);
      }
    };
  }, [history]);

  const wakeUpBackend = async () => {
    setWakingBackend(true);
    try {
      // Try health check first
      const healthResponse = await fetch(`${API_BASE}/health`, {
        method: 'GET',
        credentials: 'include',
        signal: AbortSignal.timeout(30000) // 30 second timeout
      });
      
      if (healthResponse.ok) {
        setBackendAwake(true);
        setHomeErrorMessage(''); // Clear any previous error
        return; // Stop here, backend is awake
      } else {
        throw new Error('Backend not responding');
      }
    } catch (error) {
      console.error('Backend wake-up error:', error);
      // Try ping endpoint as fallback
      try {
        const pingResponse = await fetch(`${API_BASE}/ping`, {
          method: 'GET',
          credentials: 'include',
          signal: AbortSignal.timeout(30000)
        });
        if (pingResponse.ok) {
          setBackendAwake(true);
          setHomeErrorMessage(''); // Clear any previous error
          return; // Stop here, backend is awake
        } else {
          throw new Error('Ping not responding');
        }
      } catch (pingError) {
        console.error('Ping failed:', pingError);
        setHomeErrorMessage('Backend is waking up. This may take up to 50 seconds. Please wait...');
        // Retry after delay only if both failed
        setTimeout(() => wakeUpBackend(), 5000);
      }
    } finally {
      setWakingBackend(false);
    }
  };

  // Color pool for watermarks
  const colorPool = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8',
    '#F7DC6F', '#BB8FCE', '#85C1E2', '#F8B195', '#C06C84',
    '#6C5B7B', '#355C7D', '#F67280', '#C8E6C9', '#FFD54F'
  ];

  const getNextColor = () => {
    const availableColors = colorPool.filter(color => !usedColors.has(color));
    if (availableColors.length === 0) {
      // Reset if all colors are used
      setUsedColors(new Set());
      return colorPool[0];
    }
    const color = availableColors[0];
    setUsedColors(new Set([...usedColors, color]));
    return color;
  };

  const checkQueueAvailability = async (file: File): Promise<CheckSizeResponse> => {
    const response = await fetch(`${API_BASE}/api/check-size`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_size: file.size })
    });

    if (!response.ok) {
      throw new Error('Failed to check queue availability');
    }

    return await response.json();
  };

  const waitForQueueSpace = async (file: File): Promise<boolean> => {
    return new Promise((resolve) => {
      const checkAndWait = async () => {
        try {
          const checkResult = await checkQueueAvailability(file);

          // If file is not allowed (too large), stop waiting
          if (!checkResult.allowed && checkResult.queue_available) {
            setProcessingStatus('error');
            setErrorMessage(checkResult.message);
            resolve(false);
            return;
          }

          // If queue is available now, proceed
          if (checkResult.queue_available) {
            setQueueWaitInfo(null);
            retryAttemptRef.current = 0; // Reset retry counter
            resolve(true);
            return;
          }

          // Queue still full - update wait info and continue
          // Progressive retry: 5s for first attempt, 10s for subsequent attempts
          retryAttemptRef.current += 1;
          const retrySeconds = retryAttemptRef.current === 1 ? 5 : 10;
          setQueueWaitInfo({
            activeJobs: checkResult.active_jobs,
            queueCount: checkResult.queue_count,
            retryAfterSeconds: retrySeconds,
            countdownSeconds: retrySeconds
          });

          // Start countdown
          if (queueCheckIntervalRef.current) {
            clearInterval(queueCheckIntervalRef.current);
          }

          queueCheckIntervalRef.current = setInterval(() => {
            setQueueWaitInfo(prev => {
              if (!prev || prev.countdownSeconds <= 1) {
                return prev;
              }
              return {
                ...prev,
                countdownSeconds: prev.countdownSeconds - 1
              };
            });
          }, 1000);

          // Schedule next check
          if (queueCheckTimeoutRef.current) {
            clearTimeout(queueCheckTimeoutRef.current);
          }

          queueCheckTimeoutRef.current = setTimeout(() => {
            checkAndWait();
          }, retrySeconds * 1000);

        } catch (error) {
          console.error('Queue check error:', error);
          setProcessingStatus('error');
          setErrorMessage('Failed to check queue status. Please try again.');
          resolve(false);
        }
      };

      checkAndWait();
    });
  };

  const handleUploadClick = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!chunkSize || isNaN(Number(chunkSize)) || Number(chunkSize) <= 0) {
      setHomeErrorMessage('Chunk Size need to be filled (e.g. 5 pages)');
      return;
    }

    setHomeErrorMessage('');
    fileInputRef.current?.click();
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type !== 'application/pdf') {
      setHomeErrorMessage('Invalid file type. Only PDF files are allowed.');
      return;
    }

    // Check file size FIRST while staying on homepage
    try {
      const checkResult = await checkQueueAvailability(file);

      // File too large - show error on HOMEPAGE, don't move to processing stage
      if (!checkResult.allowed) {
        setHomeErrorMessage(checkResult.message);
        return;
      }

      // Size OK - move to processing stage
      setSelectedFile(file);
      setHomeErrorMessage('');
      setCurrentStage('processing');
      setProcessingStatus('checking_queue');
      setProgress(0);
      setShowDownloadButton(false);
      setShowExpiryWarning(false);
      setQueueInfo(null);
      setQueueWaitInfo(null);
      retryAttemptRef.current = 0; // Reset retry counter

      // Queue available - show brief "ready to upload" message for 3 seconds
      if (checkResult.queue_available) {
        setProcessingStatus('queued');
        setQueueInfo({
          position: 0, // Will be assigned after upload
          jobsAhead: 0,
          estimatedWaitSeconds: 0
        });
        
        // Wait 3 seconds before starting upload
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        startProcessing(file);
        return;
      }

      // Queue full - check if we should wait
      if (checkResult.queue_count >= 10) {
        // Too many jobs - show error and stop
        const retryMinutes = checkResult.retry_after_seconds 
          ? Math.ceil(checkResult.retry_after_seconds / 60) 
          : 5;
        setProcessingStatus('error');
        setErrorMessage(
          `Server is very busy (${checkResult.queue_count} jobs in queue). ` +
          `Please try again in ${retryMinutes} minute${retryMinutes !== 1 ? 's' : ''}.`
        );
        return;
      }

      // Queue full but < 10 jobs - wait for space
      setProcessingStatus('queue_full_waiting');
      const spaceAvailable = await waitForQueueSpace(file);
      
      if (spaceAvailable) {
        // Space became available - show brief message before starting upload
        setProcessingStatus('queued');
        setQueueInfo({
          position: 0,
          jobsAhead: 0,
          estimatedWaitSeconds: 0
        });
        
        // Wait 3 seconds before starting upload
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        startProcessing(file);
      }
      // If not available, error is already set by waitForQueueSpace

    } catch (error) {
      console.error('Queue check error:', error);
      setHomeErrorMessage('Failed to check queue status. Please try again.');
    }
  };

  const startProcessing = async (file: File) => {
    try {
      // Clear any existing queue check intervals
      if (queueCheckIntervalRef.current) {
        clearInterval(queueCheckIntervalRef.current);
        queueCheckIntervalRef.current = null;
      }
      if (queueCheckTimeoutRef.current) {
        clearTimeout(queueCheckTimeoutRef.current);
        queueCheckTimeoutRef.current = null;
      }

      setProcessingStatus('uploading');
      setProgress(0);
      setShowDownloadButton(false);
      setShowExpiryWarning(false);
      setQueueInfo(null);
      setQueueWaitInfo(null);

      // Upload file with XMLHttpRequest to track progress
      const formData = new FormData();
      formData.append('file', file);
      formData.append('chunk_size', chunkSize);

      // Use XMLHttpRequest for upload progress tracking
      const uploadResponse = await new Promise<Response>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        
        // Track upload progress
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const percentComplete = Math.round((e.loaded / e.total) * 100);
            setProgress(percentComplete);
          }
        };
        
        xhr.onload = () => {
          // Convert XMLHttpRequest to fetch-like Response
          const response = new Response(xhr.response, {
            status: xhr.status,
            statusText: xhr.statusText,
            headers: new Headers(xhr.getAllResponseHeaders().split('\r\n').reduce((acc, line) => {
              const [key, value] = line.split(': ');
              if (key && value) acc[key] = value;
              return acc;
            }, {} as Record<string, string>))
          });
          resolve(response);
        };
        
        xhr.onerror = () => reject(new Error('Upload failed'));
        xhr.ontimeout = () => reject(new Error('Upload timeout'));
        
        xhr.open('POST', `${API_BASE}/api/upload`);
        xhr.withCredentials = true; // Include credentials (cookies)
        xhr.send(formData);
      });

      // Handle 503 Server Busy (race condition - queue filled during upload)
      if (uploadResponse.status === 503) {
        const errorData = await uploadResponse.json().catch(() => ({}));
        const detail = errorData.detail || errorData;
        
        // Re-check queue and wait for space
        setProcessingStatus('queue_full_waiting');
        
        const spaceAvailable = await waitForQueueSpace(file);
        
        if (spaceAvailable) {
          // Space became available - show brief message before retrying upload
          setProcessingStatus('queued');
          setQueueInfo({
            position: 0,
            jobsAhead: 0,
            estimatedWaitSeconds: 0
          });
          
          // Wait 3 seconds before retrying upload
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          await startProcessing(file);
        } else {
          // Error already set by waitForQueueSpace or user cancelled
        }
        return;
      }

      if (!uploadResponse.ok) {
        const errorData = await uploadResponse.json().catch(() => ({}));
        throw new Error(errorData.detail || 'Upload failed');
      }

      const { job_id } = await uploadResponse.json();
      setCurrentJobId(job_id);

      // Start polling for status
      pollStatus(job_id, file.name);

    } catch (error: any) {
      setProcessingStatus('error');
      setErrorMessage(error.message || 'Failed to upload file');
      console.error('Upload error:', error);
    }
  };

  const pollStatus = async (jobId: string, originalFileName: string) => {
    try {
      const response = await fetch(`${API_BASE}/api/status/${jobId}`, {
        credentials: 'include'
      });
      
      if (!response.ok) {
        throw new Error('Failed to fetch status');
      }

      const data = await response.json();

      // Update status and progress
      if (data.status === 'error') {
        setProcessingStatus('error');
        setErrorMessage(data.error || 'An error occurred during processing');
        if (pollingRef.current) {
          clearTimeout(pollingRef.current);
        }
        return;
      }

      // Extract queue information if queued
      if (data.status === 'queued') {
        setQueueInfo({
          position: data.queue_position || 0,
          jobsAhead: data.jobs_ahead || 0,
          estimatedWaitSeconds: data.estimated_wait_seconds || null
        });
      } else {
        setQueueInfo(null);
      }

      setProcessingStatus(data.status as ProcessingStatus);
      setProgress(data.progress || 0);

      if (data.status === 'finished') {
        // Stop polling
        if (pollingRef.current) {
          clearTimeout(pollingRef.current);
        }

        // Show downloading status and attempt automatic download
        setProcessingStatus('downloading');
        await handleAutoDownload(jobId, originalFileName);
      } else {
        // Continue polling every 1 second
        pollingRef.current = setTimeout(() => pollStatus(jobId, originalFileName), 1000);
      }
    } catch (error) {
      console.error('Polling error:', error);
      setProcessingStatus('error');
      setErrorMessage('Failed to check processing status');
      if (pollingRef.current) {
        clearTimeout(pollingRef.current);
      }
    }
  };

  const handleAutoDownload = async (jobId: string, originalFileName: string) => {
    try {
      const response = await fetch(`${API_BASE}/api/download/${jobId}`, {
        credentials: 'include'
      });
      
      // Handle 410 Gone (expired)
      if (response.status === 410) {
        setProcessingStatus('error');
        setErrorMessage('Download expired. Please re-upload your PDF file.');
        return;
      }

      if (!response.ok) {
        throw new Error('Download failed');
      }

      // Get total size from Content-Length header
      const contentLength = response.headers.get('Content-Length');
      const total = contentLength ? parseInt(contentLength, 10) : 0;
      
      if (!response.body) {
        throw new Error('Response body is null');
      }

      // Track download progress
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let receivedLength = 0;

      while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;
        
        chunks.push(value);
        receivedLength += value.length;
        
        // Update progress (only if we know total size)
        if (total > 0) {
          const percentage = Math.round((receivedLength / total) * 100);
          setProgress(percentage);
        }
      }

      // Combine chunks into blob
      const blob = new Blob(chunks as BlobPart[], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const watermarkedName = originalFileName.replace('.pdf', '-watermarked.pdf');
      
      // Trigger download
      const a = document.createElement('a');
      a.href = url;
      a.download = watermarkedName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      // Cleanup on backend (no credentials to avoid CORS preflight)
      await fetch(`${API_BASE}/api/cleanup/${jobId}`, { 
        method: 'DELETE'
      });

      // Set finished status
      setProcessingStatus('finished');

      // Add to history without download button
      const newItem: HistoryItem = {
        id: Date.now().toString(),
        timestamp: new Date(),
        originalName: originalFileName,
        watermarkedName: watermarkedName,
        downloadUrl: '',
        downloadFailed: false
      };
      setHistory([newItem, ...history]);

    } catch (error) {
      console.error('Auto-download failed:', error);
      setProcessingStatus('finished'); // Still mark as finished
      setShowDownloadButton(true);
      setShowExpiryWarning(true); // Show expiry warning when auto-download fails
      
      // Add to history with download button enabled
      const watermarkedName = originalFileName.replace('.pdf', '-watermarked.pdf');
      const newItem: HistoryItem = {
        id: Date.now().toString(),
        timestamp: new Date(),
        originalName: originalFileName,
        watermarkedName: watermarkedName,
        downloadUrl: '',
        downloadFailed: true,
        jobId: jobId
      };
      
      // Set 60-second timer to remove download button
      const timer = setTimeout(() => {
        setHistory(prev => prev.map(item =>
          item.id === newItem.id 
            ? { ...item, downloadFailed: false, jobId: undefined, expiryTimer: undefined }
            : item
        ));
        if (showDownloadButton && currentJobId === jobId) {
          setShowDownloadButton(false);
          setShowExpiryWarning(false);
        }
      }, 60000);
      
      newItem.expiryTimer = timer;
      setHistory([newItem, ...history]);
      
      setErrorMessage('Automatic download failed. Please use the download button.');
    }
  };

  const handleManualDownload = async (jobId: string, fileName: string) => {
    try {
      // Set downloading status to show progress
      setProcessingStatus('downloading');
      setProgress(0);
      
      const response = await fetch(`${API_BASE}/api/download/${jobId}`, {
        credentials: 'include'
      });
      
      // Handle 410 Gone (expired)
      if (response.status === 410) {
        setShowDownloadButton(false);
        setShowExpiryWarning(false);
        setProcessingStatus('error');
        setErrorMessage('Download expired (1 minute limit). Please re-upload your PDF file.');
        return;
      }

      if (!response.ok) {
        throw new Error('Download failed');
      }

      // Get total size from Content-Length header
      const contentLength = response.headers.get('Content-Length');
      const total = contentLength ? parseInt(contentLength, 10) : 0;
      
      if (!response.body) {
        throw new Error('Response body is null');
      }

      // Track download progress
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let receivedLength = 0;

      while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;
        
        chunks.push(value);
        receivedLength += value.length;
        
        // Update progress (only if we know total size)
        if (total > 0) {
          const percentage = Math.round((receivedLength / total) * 100);
          setProgress(percentage);
        }
      }

      // Combine chunks into blob
      const blob = new Blob(chunks as BlobPart[], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      
      // Trigger download
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      // Cleanup on backend (no credentials to avoid CORS preflight)
      await fetch(`${API_BASE}/api/cleanup/${jobId}`, { 
        method: 'DELETE'
      });

      // Update history item and clear expiry timer
      setHistory(prev => prev.map(item => {
        if (item.jobId === jobId) {
          if (item.expiryTimer) {
            clearTimeout(item.expiryTimer);
          }
          return { ...item, downloadFailed: false, jobId: undefined, expiryTimer: undefined };
        }
        return item;
      }));
      setShowDownloadButton(false);
      setShowExpiryWarning(false);

    } catch (error) {
      console.error('Manual download failed:', error);
      alert('Download failed. Please try again.');
    }
  };

  const handleAbort = async () => {
    // Stop polling
    if (pollingRef.current) {
      clearTimeout(pollingRef.current);
      pollingRef.current = null;
    }

    // Clear queue check intervals
    if (queueCheckIntervalRef.current) {
      clearInterval(queueCheckIntervalRef.current);
      queueCheckIntervalRef.current = null;
    }
    if (queueCheckTimeoutRef.current) {
      clearTimeout(queueCheckTimeoutRef.current);
      queueCheckTimeoutRef.current = null;
    }

    // Cleanup job if exists
    if (currentJobId) {
      try {
        await fetch(`${API_BASE}/api/cleanup/${currentJobId}`, { 
          method: 'DELETE'
        });
      } catch (error) {
        console.error('Cleanup error:', error);
      }
    }

    setProcessingStatus('error');
    setErrorMessage('Process aborted by user.');
    setQueueWaitInfo(null);
  };

  const handleOk = () => {
    // Stop any active polling
    if (pollingRef.current) {
      clearTimeout(pollingRef.current);
      pollingRef.current = null;
    }

    // Clear queue check intervals
    if (queueCheckIntervalRef.current) {
      clearInterval(queueCheckIntervalRef.current);
      queueCheckIntervalRef.current = null;
    }
    if (queueCheckTimeoutRef.current) {
      clearTimeout(queueCheckTimeoutRef.current);
      queueCheckTimeoutRef.current = null;
    }

    setCurrentStage('home');
    setProcessingStatus('idle');
    setProgress(0);
    setSelectedFile(null);
    setErrorMessage('');
    setChunkSize('');
    setCurrentJobId(null);
    setShowDownloadButton(false);
    setShowExpiryWarning(false);
    setQueueInfo(null);
    setQueueWaitInfo(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const formatDate = (date: Date) => {
    return date.toLocaleString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-6">
      <div className="w-full max-w-4xl">
        {/* Stage 1: Home Page */}
        {currentStage === 'home' && (
          <div className="bg-white rounded-2xl shadow-xl p-12">
            <div className="text-center mb-12">
              <h1 className="text-3xl font-bold text-gray-800 mb-8 leading-tight">
                Please upload your pdf here, and choose your chunk size to add colorful water marks!
              </h1>
              
              {/* Backend status message */}
              {wakingBackend && (
                <div className="max-w-md mx-auto mb-6 p-4 bg-blue-50 border-2 border-blue-500 rounded-lg">
                  <div className="flex items-start gap-3">
                    <Loader2 className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5 animate-spin" />
                    <div className="text-sm text-blue-700 text-left">
                      Waking up backend server... This may take up to 50 seconds for the first request.
                    </div>
                  </div>
                </div>
              )}
              
              {/* Error message display */}
              {homeErrorMessage && !wakingBackend && (
                <div className="max-w-md mx-auto mb-6 p-4 bg-red-50 border-2 border-red-500 rounded-lg">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                    <div className="text-sm text-red-700 text-left">{homeErrorMessage}</div>
                  </div>
                </div>
              )}
              
              <form onSubmit={handleUploadClick} className="max-w-md mx-auto space-y-6">
                <div className="space-y-2">
                  <label htmlFor="chunkSize" className="block text-left text-sm font-medium text-gray-700">
                    Chunk Size (pages) *
                  </label>
                  <input
                    id="chunkSize"
                    type="number"
                    value={chunkSize}
                    onChange={(e) => setChunkSize(e.target.value)}
                    placeholder="e.g. 5 pages"
                    className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:outline-none focus:border-indigo-500 transition-colors"
                    min="1"
                  />
                </div>
                
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf"
                  onChange={handleFileSelect}
                  className="hidden"
                />
                
                <button
                  type="submit"
                  disabled={!backendAwake || wakingBackend}
                  className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-4 px-6 rounded-lg transition-colors duration-200 flex items-center justify-center gap-3 shadow-lg hover:shadow-xl disabled:hover:shadow-lg"
                >
                  {wakingBackend ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Connecting to Backend...
                    </>
                  ) : (
                    <>
                      <Upload className="w-5 h-5" />
                      Upload PDF
                    </>
                  )}
                </button>
              </form>
            </div>

            {/* History Section */}
            {history.length > 0 && (
              <div className="mt-12 pt-8 border-t-2 border-gray-200">
                <h2 className="text-xl font-semibold text-gray-800 mb-6">Processing History</h2>
                <div className="space-y-3">
                  {history.map((item, index) => (
                    <div
                      key={item.id}
                      className="bg-gray-50 rounded-lg p-4 flex items-center justify-between hover:bg-gray-100 transition-colors"
                    >
                      <div className="flex-1">
                        <div className="text-sm text-gray-600 mb-1">
                          {formatDate(item.timestamp)}
                        </div>
                        <div className="text-base font-medium text-gray-900">
                          {item.watermarkedName}
                        </div>
                      </div>
                      {/* Show download button only for most recent item if download failed */}
                      {index === 0 && item.downloadFailed && item.jobId && (
                        <button
                          onClick={() => handleManualDownload(item.jobId!, item.watermarkedName)}
                          className="ml-4 bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 px-4 rounded-lg transition-colors duration-200 flex items-center gap-2 shadow-md hover:shadow-lg"
                        >
                          <Download className="w-4 h-4" />
                          Download
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Stage 2: Processing View */}
        {currentStage === 'processing' && (
          <div className="bg-white rounded-2xl shadow-xl p-12">
            <h2 className="text-2xl font-bold text-gray-800 mb-6 text-center">
              Processing Your PDF
            </h2>
            
            <div className="space-y-3 mb-8">
              {/* Queued */}
              <ProcessingStep
                status={processingStatus}
                currentStep="queued"
                completedSteps={['uploading', 'splitting', 'adding_watermarks', 'merging', 'downloading', 'finished']}
                label={
                  processingStatus === 'checking_queue' 
                    ? 'Checking queue availability...'
                    : processingStatus === 'queue_full_waiting' && queueWaitInfo
                    ? `Waiting for queue space (${queueWaitInfo.activeJobs} processing, ${queueWaitInfo.queueCount} queued) - Retry in ${Math.floor(queueWaitInfo.countdownSeconds / 60)}:${(queueWaitInfo.countdownSeconds % 60).toString().padStart(2, '0')}`
                    : processingStatus === 'queued' && queueInfo && queueInfo.position === 0
                    ? 'Ready to upload - Starting immediately...'
                    : 'Queued'
                }
                progress={0}
                queueInfo={queueInfo}
              />
              
              {/* Uploading */}
              <ProcessingStep
                status={processingStatus}
                currentStep="uploading"
                completedSteps={['splitting', 'adding_watermarks', 'merging', 'downloading', 'finished']}
                label="Uploading"
                requiredStep="queued"
                progress={progress}
                queueInfo={queueInfo}
              />
              
              {/* Processing (shows queue position after upload) */}
              <ProcessingStep
                status={processingStatus}
                currentStep="queued"
                completedSteps={['splitting', 'adding_watermarks', 'merging', 'downloading', 'finished']}
                label={
                  processingStatus === 'queued' && queueInfo && queueInfo.position > 0
                    ? `Processing - Position #${queueInfo.position} (${queueInfo.jobsAhead} job${queueInfo.jobsAhead !== 1 ? 's' : ''} ahead${queueInfo.estimatedWaitSeconds ? `, ~${Math.ceil(queueInfo.estimatedWaitSeconds / 60)} min` : ''})`
                    : 'Processing'
                }
                requiredStep="uploading"
                progress={0}
                isPostUploadQueue={true}
                queueInfo={queueInfo}
              />
              
              {/* Splitting the PDF */}
              <ProcessingStep
                status={processingStatus}
                currentStep="splitting"
                completedSteps={['adding_watermarks', 'merging', 'downloading', 'finished']}
                label="Splitting the PDF"
                requiredStep="uploading"
                progress={progress}
                queueInfo={queueInfo}
              />
              
              {/* Adding watermarks */}
              <ProcessingStep
                status={processingStatus}
                currentStep="adding_watermarks"
                completedSteps={['merging', 'downloading', 'finished']}
                label="Adding watermarks"
                requiredStep="splitting"
                progress={progress}
                queueInfo={queueInfo}
              />
              
              {/* Merging chunks */}
              <ProcessingStep
                status={processingStatus}
                currentStep="merging"
                completedSteps={['downloading', 'finished']}
                label="Merging chunks"
                requiredStep="adding_watermarks"
                progress={progress}
                queueInfo={queueInfo}
              />
              
              {/* Downloading */}
              <ProcessingStep
                status={processingStatus}
                currentStep="downloading"
                completedSteps={['finished']}
                label="Downloading"
                requiredStep="merging"
                progress={progress}
                queueInfo={queueInfo}
              />
              
              {/* Completed - Always reserve space */}
              <div className="min-h-[60px] flex items-center">
                {processingStatus === 'finished' && (
                  <div className="flex items-center gap-3 p-3 bg-green-50 rounded-lg border-2 border-green-500 w-full">
                    <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0" />
                    <span className="text-base font-medium text-green-800">Completed</span>
                  </div>
                )}
              </div>
              
              {/* Error - Always reserve space */}
              <div className="min-h-[60px] flex items-start">
                {processingStatus === 'error' && (
                  <div className="flex items-start gap-3 p-3 bg-red-50 rounded-lg border-2 border-red-500 w-full">
                    <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                    <div>
                      <div className="text-base font-medium text-red-800 mb-1">Error occurred</div>
                      <div className="text-sm text-red-700">{errorMessage}</div>
                    </div>
                  </div>
                )}
              </div>

              {/* Expiry Warning */}
              {showExpiryWarning && (
                <div className="bg-amber-50 border-2 border-amber-400 rounded-lg p-4 flex items-start gap-3">
                  <div className="text-amber-600 mt-0.5">
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-amber-800 font-semibold text-lg mb-1">Download Immediately!</h3>
                    <p className="text-amber-700">Your file will expire in 1 minute. Download it now before it's gone.</p>
                  </div>
                </div>
              )}

              {/* Manual Download Button */}
              {showDownloadButton && currentJobId && selectedFile && (
                <div className="flex justify-center">
                  <button
                    onClick={() => handleManualDownload(currentJobId, selectedFile.name.replace('.pdf', '-watermarked.pdf'))}
                    className="bg-green-600 hover:bg-green-700 text-white font-semibold py-3 px-8 rounded-lg transition-colors duration-200 flex items-center gap-2 shadow-md"
                  >
                    <Download className="w-5 h-5" />
                    Download PDF
                  </button>
                </div>
              )}
            </div>
            
            <div className="flex gap-4 justify-center">
              <button
                onClick={handleAbort}
                disabled={processingStatus === 'finished' || processingStatus === 'error'}
                className="bg-red-600 hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-3 px-8 rounded-lg transition-colors duration-200 flex items-center gap-2 shadow-md"
              >
                <X className="w-5 h-5" />
                Abort Process
              </button>
              
              <button
                onClick={handleOk}
                disabled={processingStatus !== 'finished' && processingStatus !== 'error'}
                className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-3 px-8 rounded-lg transition-colors duration-200 shadow-md"
              >
                OK
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface ProcessingStepProps {
  status: ProcessingStatus;
  currentStep: ProcessingStatus;
  completedSteps: ProcessingStatus[];
  label: string;
  requiredStep?: ProcessingStatus;
  progress?: number;
  isPostUploadQueue?: boolean; // Special flag for post-upload queue step (Processing)
  queueInfo?: QueueInfo | null;
}

function ProcessingStep({ status, currentStep, completedSteps, label, requiredStep, progress = 0, isPostUploadQueue = false, queueInfo }: ProcessingStepProps) {
  const stepOrder: ProcessingStatus[] = ['idle', 'checking_queue', 'queue_full_waiting', 'queued', 'uploading', 'splitting', 'adding_watermarks', 'merging', 'downloading', 'finished'];
  const currentIndex = stepOrder.indexOf(status);
  const requiredIndex = requiredStep ? stepOrder.indexOf(requiredStep) : -1;
  
  // Check if this step should be visible yet
  // Special handling for post-upload queue state (status='queued' with position > 0)
  const isPostUploadQueueState = status === 'queued' && queueInfo && queueInfo.position > 0;
  
  let isVisible: boolean;
  if (isPostUploadQueue && isPostUploadQueueState) {
    // Processing step should be visible when in post-upload queue
    isVisible = true;
  } else if (isPostUploadQueueState && requiredStep && requiredStep !== 'queued') {
    // All steps after Queued should be visible when in post-upload queue
    isVisible = true;
  } else {
    isVisible = requiredIndex < 0 || currentIndex >= requiredIndex;
  }
  
  // Special handling for Queued vs Processing steps
  let isActive: boolean;
  if (currentStep === 'queued') {
    if (isPostUploadQueue) {
      // Processing step: active when status='queued' AND position > 0 (after upload)
      isActive = status === 'queued' && queueInfo !== null && queueInfo !== undefined && queueInfo.position > 0;
    } else {
      // Queued step: active when checking queue or waiting, or when position = 0
      isActive = status === 'checking_queue' || status === 'queue_full_waiting' || 
                 (status === 'queued' && (!queueInfo || queueInfo.position === 0));
    }
  } else {
    isActive = status === currentStep;
  }
  
  // Determine if step is completed
  // Special case: Queued step and Uploading step should be completed when status='queued' with position > 0
  let isCompleted: boolean;
  if (status === 'queued' && queueInfo && queueInfo.position > 0) {
    // Post-upload queue: Queued and Uploading are completed
    isCompleted = currentStep === 'queued' || currentStep === 'uploading';
  } else {
    isCompleted = completedSteps.includes(status);
  }
  
  return (
    <div className={`rounded-lg border-2 transition-all duration-300 min-h-[60px] ${
      !isVisible
        ? 'opacity-0 pointer-events-none bg-white border-gray-200'
        : isActive 
        ? 'bg-blue-50 border-blue-500' 
        : isCompleted 
        ? 'bg-gray-50 border-gray-300' 
        : 'bg-white border-gray-200'
    }`}>
      <div className="flex items-center gap-3 p-3">
        {isActive ? (
          <Loader2 className="w-5 h-5 text-blue-600 animate-spin flex-shrink-0" />
        ) : isCompleted ? (
          <CheckCircle className="w-5 h-5 text-gray-400 flex-shrink-0" />
        ) : (
          <div className="w-5 h-5 rounded-full border-2 border-gray-300 flex-shrink-0" />
        )}
        <span className={`text-base font-medium ${
          isActive ? 'text-blue-800' : isCompleted ? 'text-gray-600' : 'text-gray-400'
        }`}>
          {label}
        </span>
      </div>
      {/* Progress bar for active step */}
      {isActive && progress > 0 && (
        <div className="px-3 pb-3">
          <div className="w-full bg-blue-200 rounded-full h-2">
            <div 
              className="bg-blue-600 h-2 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            ></div>
          </div>
          <div className="text-xs text-blue-600 mt-0.5 text-right">{progress}%</div>
        </div>
      )}
    </div>
  );
}