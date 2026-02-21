# Deployment Guide - GitHub Pages

## Overview
This guide explains how to deploy the WaterMarks frontend to GitHub Pages and configure the backend on Render.

## Prerequisites
- Backend deployed on Render: `https://watermarks-backend.onrender.com`
- GitHub repository: `https://github.com/yuanfengli168/WaterMarks`

## Frontend Deployment (GitHub Pages)

### 1. Enable GitHub Pages
1. Go to your GitHub repository
2. Navigate to **Settings** → **Pages**
3. Under "Build and deployment":
   - **Source**: Select "GitHub Actions"
   - This allows the workflow to deploy automatically

### 2. Push Your Code
```bash
git add .
git commit -m "Configure for GitHub Pages deployment"
git push origin main
```

The GitHub Actions workflow will automatically:
- Build the project with production environment variables
- Deploy to GitHub Pages
- Your site will be available at: `https://yuanfengli168.github.io/WaterMarks/`

### 3. Monitor Deployment
- Go to the **Actions** tab in your GitHub repository
- Watch the deployment progress
- First deployment takes ~2-3 minutes

## Backend Configuration (Render CORS)

### ⚠️ CRITICAL: Update CORS Settings

You MUST update your backend CORS configuration to allow requests from GitHub Pages.

**In your backend code**, update the CORS middleware:

```python
from fastapi.middleware.cors import CORSMiddleware

# Update your CORS origins to include GitHub Pages
origins = [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:5174",
    "https://yuanfengli168.github.io",  # ✅ ADD THIS
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

**Then redeploy your backend on Render:**
1. Commit and push your backend changes
2. Render will automatically redeploy
3. Or manually trigger a deploy from the Render dashboard

## Environment Variables

### Local Development
Create a `.env` file (already in .gitignore):
```bash
cp .env.example .env
```

Content:
```
VITE_API_BASE_URL=http://localhost:8000
```

### Production (GitHub Actions)
The production URL is set in `.github/workflows/deploy.yml`:
```yaml
VITE_API_BASE_URL: https://watermarks-backend.onrender.com
```

## Testing the Deployment

### 1. Test Backend Wake-up
- Visit: `https://yuanfengli168.github.io/WaterMarks/`
- You should see "Waking up backend server..." initially
- Wait up to 50 seconds for Render to wake up
- The upload button will enable when backend is ready

### 2. Test Upload Flow
- Choose a chunk size (e.g., 5 pages)
- Upload a PDF file
- Monitor the processing status
- Download should trigger automatically

### 3. Common Issues

#### ❌ "CORS Error" in Browser Console
**Solution**: Update backend CORS settings (see above) and redeploy on Render

#### ❌ "Backend not responding" for >1 minute
**Solution**: 
- Check Render backend status: `https://watermarks-backend.onrender.com/health`
- Render free tier may take longer to wake up
- Refresh the page and try again

#### ❌ 404 Error on GitHub Pages
**Solution**:
- Verify GitHub Pages is enabled
- Check the Actions tab for deployment errors
- Ensure the workflow completed successfully

#### ❌ Assets not loading (blank page)
**Solution**:
- Check that `base: '/WaterMarks/'` is set in `vite.config.ts`
- Rebuild and redeploy

## Manual Deployment (Alternative)

If you prefer to deploy manually without GitHub Actions:

```bash
# 1. Build the project
VITE_API_BASE_URL=https://watermarks-backend.onrender.com npm run build

# 2. Install gh-pages
npm install --save-dev gh-pages

# 3. Add to package.json scripts:
"deploy": "gh-pages -d dist"

# 4. Deploy
npm run deploy
```

## Monitoring

### Backend Health Check
```bash
curl https://watermarks-backend.onrender.com/health
```

### Frontend URL
Production: `https://yuanfengli168.github.io/WaterMarks/`

## Notes

- **Render Free Tier**: Backend sleeps after 15 minutes of inactivity
- **Wake-up Time**: First request may take 30-50 seconds
- **GitHub Pages**: Updates automatically on every push to main branch
- **No Server Required**: GitHub Pages is completely free for public repos
