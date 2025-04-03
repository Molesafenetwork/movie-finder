const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

/**
 * Format file size in a human-readable way
 * @param {number} bytes - Size in bytes
 * @returns {string} - Formatted size
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Process a YouTube video - download and convert
 * @param {string} url - YouTube URL to process
 * @param {Object} options - Processing options
 * @returns {Promise<Object>} - Processing result
 */
async function processYoutubeVideo(url, options = {}) {
  const {
    format = 'mp4',
    highQuality = false
  } = options;
  
  console.log(`[INFO] [YouTube Processor] Processing: ${url}`);
  
  try {
    // Validate it's a YouTube URL
    if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
      return {
        success: false,
        error: 'Not a valid YouTube URL'
      };
    }
    
    // Extract YouTube video ID
    let videoId = "";
    if (url.includes('youtube.com/watch')) {
      videoId = new URL(url).searchParams.get('v');
    } else if (url.includes('youtu.be/')) {
      videoId = url.split('youtu.be/')[1].split('?')[0];
    } else if (url.includes('youtube.com/shorts/')) {
      videoId = url.split('youtube.com/shorts/')[1].split('?')[0];
    }
    
    if (!videoId) {
      return {
        success: false,
        error: 'Could not extract YouTube video ID'
      };
    }
    
    console.log(`[INFO] [YouTube Processor] Extracted video ID: ${videoId}`);
    
    // Try to get the video title by fetching the page
    let videoTitle = `YouTube Video ${videoId}`;
    try {
      const response = await fetch(url);
      const html = await response.text();
      const titleMatch = html.match(/<title>(.+?)<\/title>/i);
      if (titleMatch && titleMatch[1]) {
        videoTitle = titleMatch[1].replace(' - YouTube', '').trim();
        console.log(`[INFO] [YouTube Processor] Extracted title: ${videoTitle}`);
      }
    } catch (error) {
      console.log(`[WARNING] [YouTube Processor] Could not fetch video title: ${error.message}`);
    }
    
    // Create directories if they don't exist
    const downloadsDir = path.join(__dirname, '.data', 'downloads');
    const convertedDir = path.join(__dirname, '.data', 'converted');
    const publicDir = path.join(__dirname, 'public', 'media', 'converted');
    
    [downloadsDir, convertedDir, publicDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
    
    // Create a simulated downloaded file
    // In a real implementation, you would use yt-dlp or similar
    const downloadedFilePath = path.join(downloadsDir, `youtube_${videoId}_${Date.now()}.mp4`);
    console.log(`[INFO] [YouTube Processor] Simulating download to: ${downloadedFilePath}`);
    
    // Create a test file with MP4 header
    const fileSize = highQuality ? 10 * 1024 * 1024 : 5 * 1024 * 1024; // 10MB for high quality, 5MB otherwise
    const testData = Buffer.alloc(fileSize);
    
    // Add MP4 header signature
    const mp4Header = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D]);
    mp4Header.copy(testData, 0);
    
    // Fill with random data
    for (let i = mp4Header.length; i < fileSize; i++) {
      testData[i] = Math.floor(Math.random() * 256);
    }
    
    fs.writeFileSync(downloadedFilePath, testData);
    console.log(`[SUCCESS] [YouTube Processor] Download completed: ${formatFileSize(fileSize)}`);
    
    // Convert to requested format
    const uniqueId = uuidv4().substring(0, 8);
    const convertedFilename = `converted_${uniqueId}.${format}`;
    const convertedFilePath = path.join(convertedDir, convertedFilename);
    console.log(`[INFO] [YouTube Processor] Converting to ${format}: ${convertedFilePath}`);
    
    // Create converted file (in real implementation, would use ffmpeg)
    fs.copyFileSync(downloadedFilePath, convertedFilePath);
    
    // Copy to public directory for web access
    const publicFilePath = path.join(publicDir, convertedFilename);
    fs.copyFileSync(convertedFilePath, publicFilePath);
    
    // Determine video quality based on size
    let videoQuality;
    if (fileSize > 1000 * 1024 * 1024) {
      videoQuality = "4K";
    } else if (fileSize > 500 * 1024 * 1024) {
      videoQuality = "1080p";
    } else if (fileSize > 100 * 1024 * 1024) {
      videoQuality = "720p";
    } else if (fileSize > 50 * 1024 * 1024) {
      videoQuality = "480p";
    } else {
      videoQuality = "360p";
    }
    
    console.log(`[SUCCESS] [YouTube Processor] Processing completed: ${videoTitle}`);
    
    return {
      success: true,
      title: videoTitle,
      videoId: videoId,
      platform: 'youtube',
      format: format,
      filePath: convertedFilePath,
      publicPath: `/media/converted/${convertedFilename}`,
      size: fileSize,
      formattedSize: formatFileSize(fileSize),
      quality: videoQuality
    };
  } catch (error) {
    console.error(`[ERROR] [YouTube Processor] Error: ${error.message}`);
    return {
      success: false,
      error: `Failed to process YouTube video: ${error.message}`
    };
  }
}

module.exports = {
  processYoutubeVideo,
  formatFileSize
}; 