import { useState, useRef, useEffect } from 'react';
import { Upload, AlertCircle, CheckCircle, Loader2, Download, X } from 'lucide-react';

// Types
type ProcessingStatus = 'idle' | 'uploading' | 'splitting' | 'adding_watermarks' | 'finished' | 'error';

interface HistoryItem {
  id: string;
  timestamp: Date;
  originalName: string;
  watermarkedName: string;
  downloadUrl: string;
  downloadFailed: boolean;
  jobId?: string;
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
  const [backendAwake, setBackendAwake] = useState(false);
  const [wakingBackend, setWakingBackend] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  // Use environment variable for API URL, fallback to localhost for development
  // In production (GitHub Pages), use the Render backend URL
  const API_BASE = import.meta.env.VITE_API_BASE_URL || 
    (import.meta.env.PROD ? 'https://watermarks-backend.onrender.com' : 'http://localhost:8000');

  // Wake up backend on component mount
  useEffect(() => {
    wakeUpBackend();
  }, []);

  const wakeUpBackend = async () => {
    setWakingBackend(true);
    try {
      // Try health check first
      const healthResponse = await fetch(`${API_BASE}/health`, {
        method: 'GET',
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

    // Check file size before proceeding
    try {
      const response = await fetch(`${API_BASE}/api/check-size`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_size: file.size })
      });

      const data = await response.json();
      
      if (!data.allowed) {
        setHomeErrorMessage(data.message || 'File is too large');
        return;
      }

      // Size check passed, proceed to processing
      setSelectedFile(file);
      setHomeErrorMessage('');
      setCurrentStage('processing');
      startProcessing(file);
    } catch (error) {
      setHomeErrorMessage('Failed to check file size. Please try again.');
      console.error('Size check error:', error);
    }
  };

  const startProcessing = async (file: File) => {
    try {
      setProcessingStatus('uploading');
      setProgress(0);
      setShowDownloadButton(false);

      // Upload file
      const formData = new FormData();
      formData.append('file', file);
      formData.append('chunk_size', chunkSize);

      const uploadResponse = await fetch(`${API_BASE}/api/upload`, {
        method: 'POST',
        body: formData
      });

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
      const response = await fetch(`${API_BASE}/api/status/${jobId}`);
      
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

      setProcessingStatus(data.status as ProcessingStatus);
      setProgress(data.progress || 0);

      if (data.status === 'finished') {
        // Stop polling
        if (pollingRef.current) {
          clearTimeout(pollingRef.current);
        }

        // Attempt automatic download
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
      const response = await fetch(`${API_BASE}/api/download/${jobId}`);
      
      if (!response.ok) {
        throw new Error('Download failed');
      }

      const blob = await response.blob();
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

      // Cleanup on backend
      await fetch(`${API_BASE}/api/cleanup/${jobId}`, { method: 'DELETE' });

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
      setShowDownloadButton(true);
      
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
      setHistory([newItem, ...history]);
      
      setErrorMessage('Automatic download failed. Please use the download button.');
    }
  };

  const handleManualDownload = async (jobId: string, fileName: string) => {
    try {
      const response = await fetch(`${API_BASE}/api/download/${jobId}`);
      
      if (!response.ok) {
        throw new Error('Download failed');
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      // Cleanup on backend
      await fetch(`${API_BASE}/api/cleanup/${jobId}`, { method: 'DELETE' });

      // Update history item to mark download as successful
      setHistory(history.map(item => 
        item.jobId === jobId ? { ...item, downloadFailed: false, jobId: undefined } : item
      ));
      setShowDownloadButton(false);

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

    // Cleanup job if exists
    if (currentJobId) {
      try {
        await fetch(`${API_BASE}/api/cleanup/${currentJobId}`, { method: 'DELETE' });
      } catch (error) {
        console.error('Cleanup error:', error);
      }
    }

    setProcessingStatus('error');
    setErrorMessage('Process aborted by user.');
  };

  const handleOk = () => {
    // Stop any active polling
    if (pollingRef.current) {
      clearTimeout(pollingRef.current);
      pollingRef.current = null;
    }

    setCurrentStage('home');
    setProcessingStatus('idle');
    setProgress(0);
    setSelectedFile(null);
    setErrorMessage('');
    setChunkSize('');
    setCurrentJobId(null);
    setShowDownloadButton(false);
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
            <h2 className="text-2xl font-bold text-gray-800 mb-8 text-center">
              Processing Your PDF
            </h2>
            
            <div className="space-y-6 mb-12">
              {/* Uploading */}
              <ProcessingStep
                status={processingStatus}
                currentStep="uploading"
                completedSteps={['splitting', 'adding_watermarks', 'finished']}
                label="Uploading"
                progress={progress}
              />
              
              {/* Splitting the PDF */}
              <ProcessingStep
                status={processingStatus}
                currentStep="splitting"
                completedSteps={['adding_watermarks', 'finished']}
                label="Splitting the PDF"
                requiredStep="uploading"
                progress={progress}
              />
              
              {/* Adding watermarks */}
              <ProcessingStep
                status={processingStatus}
                currentStep="adding_watermarks"
                completedSteps={['finished']}
                label="Adding watermarks"
                requiredStep="splitting"
                progress={progress}
              />
              
              {/* Completed - Always reserve space */}
              <div className="min-h-[72px] flex items-center">
                {processingStatus === 'finished' && (
                  <div className="flex items-center gap-4 p-4 bg-green-50 rounded-lg border-2 border-green-500 w-full">
                    <CheckCircle className="w-6 h-6 text-green-600 flex-shrink-0" />
                    <span className="text-lg font-medium text-green-800">Completed</span>
                  </div>
                )}
              </div>
              
              {/* Error - Always reserve space */}
              <div className="min-h-[72px] flex items-start">
                {processingStatus === 'error' && (
                  <div className="flex items-start gap-4 p-4 bg-red-50 rounded-lg border-2 border-red-500 w-full">
                    <AlertCircle className="w-6 h-6 text-red-600 flex-shrink-0 mt-0.5" />
                    <div>
                      <div className="text-lg font-medium text-red-800 mb-1">Error occurred</div>
                      <div className="text-sm text-red-700">{errorMessage}</div>
                    </div>
                  </div>
                )}
              </div>

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
}

function ProcessingStep({ status, currentStep, completedSteps, label, requiredStep, progress = 0 }: ProcessingStepProps) {
  const stepOrder: ProcessingStatus[] = ['idle', 'uploading', 'splitting', 'adding_watermarks', 'finished'];
  const currentIndex = stepOrder.indexOf(status);
  const requiredIndex = requiredStep ? stepOrder.indexOf(requiredStep) : -1;
  
  // Check if this step should be visible yet
  const isVisible = requiredIndex < 0 || currentIndex >= requiredIndex;
  
  const isActive = status === currentStep;
  const isCompleted = completedSteps.includes(status);
  
  return (
    <div className={`rounded-lg border-2 transition-all duration-300 min-h-[72px] ${
      !isVisible
        ? 'opacity-0 pointer-events-none bg-white border-gray-200'
        : isActive 
        ? 'bg-blue-50 border-blue-500' 
        : isCompleted 
        ? 'bg-gray-50 border-gray-300' 
        : 'bg-white border-gray-200'
    }`}>
      <div className="flex items-center gap-4 p-4">
        {isActive ? (
          <Loader2 className="w-6 h-6 text-blue-600 animate-spin flex-shrink-0" />
        ) : isCompleted ? (
          <CheckCircle className="w-6 h-6 text-gray-400 flex-shrink-0" />
        ) : (
          <div className="w-6 h-6 rounded-full border-2 border-gray-300 flex-shrink-0" />
        )}
        <span className={`text-lg font-medium ${
          isActive ? 'text-blue-800' : isCompleted ? 'text-gray-600' : 'text-gray-400'
        }`}>
          {label}
        </span>
      </div>
      {/* Progress bar for active step */}
      {isActive && progress > 0 && (
        <div className="px-4 pb-4">
          <div className="w-full bg-blue-200 rounded-full h-2.5">
            <div 
              className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            ></div>
          </div>
          <div className="text-xs text-blue-600 mt-1 text-right">{progress}%</div>
        </div>
      )}
    </div>
  );
}