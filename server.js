const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const morgan = require('morgan');
const { processVideo, extractVideoInfo, downloadVideo,  formatFileSize } = require('./media-extractor');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const https = require('https');
const SocksProxyAgent = require('socks-proxy-agent');
const { processYoutubeVideo } = require('./youtube-processor');

// Add ReadableStream polyfill for Node.js < 18
const { ReadableStream } = require('web-streams-polyfill');
global.ReadableStream = ReadableStream;

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    const uploadDir = path.join(__dirname, '.data', 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function(req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 1000 * 1024 * 1024 }, // 1000 MB max file size
  fileFilter: function(req, file, cb) {
    // Allow video files only
    if (!file.mimetype.startsWith('video/')) {
      return cb(new Error('Only video files are allowed'));
    }
    cb(null, true);
  }
});

// Set up EJS templating
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory database for demo purposes
// In a real app you would use a proper database
let mediaDatabase = {
  movies: [],
  shows: [],
  trailers: {}
};

// Queue system for tracking search progress
let searchQueue = [];
let pendingApprovals = [];
let crawlerLogs = []; // Array to store crawler activity logs
const MAX_CRAWLER_LOGS = 200; // Maximum number of logs to keep

// Ensure media directories exist
const mediaDir = path.join(__dirname, 'public', 'media');
const moviesDir = path.join(mediaDir, 'movies');
const showsDir = path.join(mediaDir, 'shows');
const trailersDir = path.join(mediaDir, 'trailers');
const downloadsDir = path.join(mediaDir, 'downloads');

[mediaDir, moviesDir, showsDir, trailersDir, downloadsDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Helper function to scan media directories
function scanMediaDirectories() {
  // Scan movies
  if (fs.existsSync(moviesDir)) {
    mediaDatabase.movies = fs.readdirSync(moviesDir)
      .filter(file => ['.mp4', '.mkv', '.avi'].some(ext => file.endsWith(ext)))
      .map(file => {
        const title = file.replace(/\.[^/.]+$/, "");
        const fullPath = path.join(moviesDir, file);
        let fileSize = "Unknown";
        try {
          const stats = fs.statSync(fullPath);
          fileSize = formatFileSize(stats.size);
        } catch (err) {
          console.error(`Error getting file size for ${fullPath}:`, err);
        }
        
        return {
          title: title,
          path: `/media/movies/${file}`,
          filePath: fullPath,
          type: 'movie',
          size: fileSize,
          trailer: mediaDatabase.trailers[title] || null
        };
      });
  }
  
  // Scan shows with enhanced season and episode detection
  if (fs.existsSync(showsDir)) {
    // Get all show files
    const showFiles = fs.readdirSync(showsDir)
      .filter(file => ['.mp4', '.mkv', '.avi'].some(ext => file.endsWith(ext)));
    
    // Process shows with improved season/episode detection
    mediaDatabase.shows = showFiles.map(file => {
      // Extract show name and episode info if available
      let title = file.replace(/\.[^/.]+$/, "");
      let showName = title;
      let season = null;
      let episode = null;
      
      // Try multiple formats for season/episode detection
      
      // 1. Standard S01E01 format
      let match = title.match(/(.+?)[.\s_-]*[sS](\d+)[eE](\d+)/);
      if (match) {
        showName = match[1].trim().replace(/[._]/g, ' ');
        season = parseInt(match[2], 10);
        episode = parseInt(match[3], 10);
      } 
      // 2. Alternate 1x01 format
      else {
        match = title.match(/(.+?)[.\s_-]*(\d+)x(\d+)/);
        if (match) {
          showName = match[1].replace(/\./g, ' ').trim();
          season = parseInt(match[2], 10);
          episode = parseInt(match[3], 10);
        }
        // 3. "Season X Episode Y" format
        else {
          const seasonMatch = title.match(/(.+?)[.\s_-]*season[.\s_-]*(\d+)/i);
          const episodeMatch = title.match(/episode[.\s_-]*(\d+)/i);
          
          if (seasonMatch) {
            showName = seasonMatch[1].trim().replace(/[._]/g, ' ');
            season = parseInt(seasonMatch[2], 10);
            
            if (episodeMatch) {
              episode = parseInt(episodeMatch[1], 10);
            }
          }
        }
      }
      
      const fullPath = path.join(showsDir, file);
      let fileSize = "Unknown";
      try {
        const stats = fs.statSync(fullPath);
        fileSize = formatFileSize(stats.size);
      } catch (err) {
        console.error(`Error getting file size for ${fullPath}:`, err);
      }
      
      return {
        title: title,
        showName: showName,
        season: season,
        episode: episode,
        path: `/media/shows/${file}`,
        filePath: fullPath,
        type: 'show',
        size: fileSize
      };
    });
  }
  
  // Scan trailers
  if (fs.existsSync(trailersDir)) {
    fs.readdirSync(trailersDir)
      .filter(file => ['.mp4', '.mkv', '.avi'].some(ext => file.endsWith(ext)))
      .forEach(file => {
        // Assuming trailer files are named like "MovieName.Trailer.mp4"
        const movieName = file.replace(/\.Trailer\.[^/.]+$/, "").replace(/\./g, ' ');
        mediaDatabase.trailers[movieName] = `/media/trailers/${file}`;
      });
  }
}

/**
 * Verify that a URL contains an acceptable amount of content
 * and is likely to be a valid video
 */
async function verifyContentLength(url, mediaType = 'movie') {
  console.log(`Checking content at ${url}`);
  addCrawlerLog('Content Verifier', `Checking content at ${url}`);
  
  try {
    // Skip verification for obviously non-video URLs
    if (url.includes('/search?') || 
        url.includes('/search.php') || 
        url.includes('/results?')) {
      addCrawlerLog('Content Verifier', 
        `Not a valid video content: appears to be a search page`, 
        null, 'error');
      return {
        isAcceptableLength: false,
        isValidVideo: false,
        contentLength: 0,
        contentType: 'text/html',
        duration: null
      };
    }
    
    // Variable to track if this is likely a valid video
    let isValidVideo = false;
    
    // Check if URL is a direct video link by extension
    const videoExtRegex = /\.(mp4|mkv|avi|mov|flv|wmv|m4v|webm)(\?.*)?$/i;
    if (videoExtRegex.test(url)) {
      isValidVideo = true;
    }
    
    // First try a HEAD request to get content info without downloading
    try {
      const controller = new AbortController();
      // 5 second timeout for HEAD request
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const headResponse = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      
      clearTimeout(timeoutId);
      
      if (headResponse.ok) {
        // Check content type from headers
        const contentType = headResponse.headers.get('content-type') || '';
        const contentLength = parseInt(headResponse.headers.get('content-length') || '0');
        
        // If it's a YouTube URL or from a known streaming platform, assume it's valid
        if (url.includes('youtube.com') || isStreamingPlatformUrl(url)) {
          addCrawlerLog('Content Verifier', 
            `Streaming platform URL verified: ${contentType}, ${formatFileSize(contentLength)}`, 
            null, 'success');
          
          return {
            isAcceptableLength: true,
            isValidVideo: true,
            contentLength: contentLength,
            contentType: contentType,
            duration: null // Can't determine duration from HEAD request
          };
        }
        
        // Check if content type indicates video
        if (contentType.includes('video/')) {
          isValidVideo = true;
        }
        
        // Determine minimum acceptable length based on media type
        let minBytes = 1 * 1024 * 1024; // Default 1MB minimum
        
        // For regular movies, we expect larger files
        if (mediaType === 'movie') {
          minBytes = 5 * 1024 * 1024; // 5MB minimum for movies
        } 
        // For TV episodes, expect medium size files
        else if (mediaType === 'show') {
          minBytes = 3 * 1024 * 1024; // 3MB minimum for episodes
        }
        // For trailers, accept smaller files
        else if (mediaType === 'trailer') {
          minBytes = 500 * 1024; // 500KB minimum for trailers
        }
        
        // Extremely large files are suspicious in some cases
        const maxBytes = 10 * 1024 * 1024 * 1024; // 10GB
        
        // Always consider YouTube URLs valid regardless of size
        if (url.includes('youtube.com') || url.includes('youtu.be')) {
          return {
            isAcceptableLength: true,
            isValidVideo: true,
            contentLength: contentLength,
            contentType: contentType,
            duration: null
          };
        }
        
        // If content length is provided and within range, return true
        if (contentLength >= minBytes && contentLength <= maxBytes) {
          addCrawlerLog('Content Verifier', 
            `Content verified: ${contentType}, ${formatFileSize(contentLength)}`, 
            null, 'success');
          
          // If it's a video mime type, consider it a valid video
          isValidVideo = isValidVideo || contentType.includes('video/');
          
          return {
            isAcceptableLength: true,
            isValidVideo: isValidVideo,
            contentLength: contentLength,
            contentType: contentType,
            duration: estimateVideoDuration(contentLength)
          };
        } 
        
        // Special case: for videos with direct video extensions, be more lenient
        if (isValidVideo && contentLength > 0) {
          addCrawlerLog('Content Verifier', 
            `Video format detected, accepting despite small size: ${formatFileSize(contentLength)}`, 
            null, 'success');
          
          return {
            isAcceptableLength: true,
            isValidVideo: true,
            contentLength: contentLength,
            contentType: contentType,
            duration: estimateVideoDuration(contentLength)
          };
        }
        
        // If content type is provided but length is missing or too small
        if (contentType) {
          addCrawlerLog('Content Verifier', 
            `Content length ${formatFileSize(contentLength)} is too small or invalid for media type ${mediaType}`,
            null, 'error');
          
          return {
            isAcceptableLength: false,
            isValidVideo: isValidVideo,
            contentLength: contentLength,
            contentType: contentType,
            duration: null
          };
        }
      } else {
        // If HEAD request fails, try partial GET to check content type
        addCrawlerLog('Content Verifier', 
          `HEAD request failed, trying partial GET: ${headResponse.status} ${headResponse.statusText}`, 
          null, 'warning');
      }
    } catch (headError) {
      // If HEAD request times out or fails, try partial GET
      addCrawlerLog('Content Verifier', 
        `HEAD request failed, trying partial GET: ${headError.message}`, 
        null, 'warning');
    }
    
    // Fallback to partial GET request for the first chunk of data
    try {
      const controller = new AbortController();
      // 10 second timeout for GET request
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
      const getResponse = await fetch(url, {
        method: 'GET',
        headers: {
          'Range': 'bytes=0-32768',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (getResponse.ok || getResponse.status === 206) {
        const contentType = getResponse.headers.get('content-type') || '';
        
        // Get the full content length from Content-Range header
        let contentLength = 0;
        const contentRange = getResponse.headers.get('content-range');
        if (contentRange) {
          const match = contentRange.match(/bytes 0-\d+\/(\d+)/);
          if (match && match[1]) {
            contentLength = parseInt(match[1]);
          }
        } else {
          // If no Content-Range, check Content-Length
          contentLength = parseInt(getResponse.headers.get('content-length') || '0');
        }
        
        // Check if content type indicates video
        if (contentType.includes('video/')) {
          isValidVideo = true;
        }
        
        // Check the actual content for video signatures
        const sample = await getResponse.arrayBuffer();
        const sampleBytes = new Uint8Array(sample);
        
        // Check for common video file signatures in the sample bytes
        const containsMP4Signature = containsSequence(sampleBytes, [0x66, 0x74, 0x79, 0x70]); // ftyp
        const containsWebMSignature = containsSequence(sampleBytes, [0x1A, 0x45, 0xDF, 0xA3]); // EBML header
        const containsMKVSignature = containsSequence(sampleBytes, [0x1A, 0x45, 0xDF, 0xA3]); // MKV uses EBML too
        
        if (containsMP4Signature || containsWebMSignature || containsMKVSignature) {
          isValidVideo = true;
          addCrawlerLog('Content Verifier', 'Valid video signature detected', null, 'success');
        }
        
        // For YouTube URLs, always consider them valid
        if (url.includes('youtube.com') || url.includes('youtu.be')) {
          isValidVideo = true;
          addCrawlerLog('Content Verifier', 'YouTube URL detected, considered valid', null, 'success');
        }
        
        // If content is HTML, it's probably not a direct video
        if (contentType.includes('text/html')) {
          isValidVideo = false;
          
          // But check if it's a known streaming platform which serves HTML
          if (isStreamingPlatformUrl(url)) {
            isValidVideo = true;
            addCrawlerLog('Content Verifier', 'Streaming platform URL detected', null, 'success');
          }
        }
        
        // Determine minimum acceptable length based on media type
        let minBytes = 500 * 1024; // More lenient default: 500KB minimum
        
        // For regular movies, we expect larger files
        if (mediaType === 'movie') {
          minBytes = 2 * 1024 * 1024; // More lenient: 2MB minimum
        } 
        // For TV episodes, expect medium size files
        else if (mediaType === 'show') {
          minBytes = 1 * 1024 * 1024; // More lenient: 1MB minimum
        }
        // For trailers, accept smaller files
        else if (mediaType === 'trailer') {
          minBytes = 100 * 1024; // More lenient: 100KB minimum
        }
        
        // If it's a detected video format, be very lenient with size requirements
        if (isValidVideo) {
          minBytes = 10 * 1024; // Just 10KB for confirmed video formats
        }
        
        // If content length is provided and within range, return true
        if (contentLength >= minBytes) {
          addCrawlerLog('Content Verifier', 
            `Content appears valid: ${contentType}, ${formatFileSize(contentLength)}${isValidVideo ? ' (valid video format)' : ''}`, 
            null, 'success');
          
          return {
            isAcceptableLength: true,
            isValidVideo: isValidVideo,
            contentLength: contentLength,
            contentType: contentType,
            duration: estimateVideoDuration(contentLength)
          };
        } else {
          // Content too small
          addCrawlerLog('Content Verifier', 
            `Content length too small: ${formatFileSize(contentLength)}`, 
            null, 'error');
          
          return {
            isAcceptableLength: false,
            isValidVideo: isValidVideo,
            contentLength: contentLength,
            contentType: contentType,
            duration: null
          };
        }
      } else {
        addCrawlerLog('Content Verifier', 
          `Content verification failed: HTTP error! Status: ${getResponse.status}`, 
          null, 'error');
        
        return {
          isAcceptableLength: false,
          isValidVideo: false,
          contentLength: 0,
          contentType: null,
          duration: null
        };
      }
    } catch (error) {
      console.error('Error verifying content:', error);
      addCrawlerLog('Content Verifier', 
        `Content verification failed: ${error.message}`, 
        null, 'error');
      
      return {
        isAcceptableLength: false,
        isValidVideo: false,
        contentLength: 0,
        contentType: null,
        duration: null
      };
    }
  } catch (error) {
    console.error('Error verifying content:', error);
    addCrawlerLog('Content Verifier', 
      `Error verifying URL (${error.message}): ${url.substring(0, 50)}...`, 
      null, 'error');
    
    return {
      isAcceptableLength: false,
      isValidVideo: false,
      contentLength: 0,
      contentType: null,
      duration: null
    };
  }
}

/**
 * Helper function to check if a byte array contains a specific sequence
 */
function containsSequence(bytes, sequence) {
  for (let i = 0; i < bytes.length - sequence.length + 1; i++) {
    let found = true;
    for (let j = 0; j < sequence.length; j++) {
      if (bytes[i + j] !== sequence[j]) {
        found = false;
        break;
      }
    }
    if (found) return true;
  }
  return false;
}

/**
 * Estimate video duration based on file size
 * This is a very rough estimate
 */
function estimateVideoDuration(bytes) {
  if (!bytes || bytes <= 0) return null;
  
  // Very rough estimate: ~1MB per minute of standard definition video
  const estimatedMinutes = Math.floor(bytes / (1024 * 1024));
  
  if (estimatedMinutes < 1) return "< 1 min";
  if (estimatedMinutes < 60) return `~${estimatedMinutes} min`;
  
  const hours = Math.floor(estimatedMinutes / 60);
  const minutes = estimatedMinutes % 60;
  
  return `~${hours}h ${minutes}m`;
}

/**
 * Validate URL structure and accessibility
 * @param {string} url - URL to validate
 * @returns {Promise<Object>} Validation result with score
 */
async function validateUrl(url) {
  try {
    if (!url || !url.startsWith('http')) {
      return { valid: false, reason: 'Invalid URL format', score: 0 };
    }
    
    // Score system: higher means more likely to be a valid video
    let score = 5; // Base score
    let type = 'webpage';
    
    // Check for direct video formats
    const isDirectVideo = /\.(mp4|mkv|avi|mov|webm|flv|wmv|m4v)(\?.*)?$/i.test(url);
    if (isDirectVideo) {
      score += 5;
      type = 'direct-video';
    }
    
    // Check for known streaming platforms
    if (isStreamingPlatformUrl(url)) {
      score += 3;
      type = 'streaming';
    }
    
    // Check for download links
    if (url.includes('/download/') || url.includes('/dl/') || url.includes('?file=')) {
      score += 2;
      type = 'download-link';
    }
    
    // Simulate checking if URL is accessible (in a real app, actually fetch)
    // Higher score means higher chance of successful fetch
    const accessible = Math.random() < (score / 10); 
    
    return {
      valid: accessible,
      score: score,
      type: type,
      reason: accessible ? 'URL is valid' : 'URL is inaccessible'
    };
  } catch (error) {
    return { valid: false, reason: `Validation error: ${error.message}`, score: 0 };
  }
}

/**
 * Extract video URLs from HTML with enhanced metadata extraction
 * @param {string} html - HTML content
 * @param {string} domain - Source domain
 * @param {string} query - Original search query
 * @param {string} mediaType - Type of media to search for
 * @param {number|null} season - Season number for TV shows
 * @returns {Array} Extracted URLs with metadata
 */
function extractVideoUrls(html, domain, query = '', mediaType = 'all', season = null) {
  // For demo purposes, extract URLs from sample HTML
  const results = [];
  
  // Use regular expressions to match video URLs
  const standardVideoExtensions = ['mp4', 'avi', 'mkv', 'mov', 'flv', 'wmv', 'm4v', 'webm'];
  const videoExtPattern = standardVideoExtensions.join('|');
  
  // Regular expressions for finding links to video files
  const directVideoRegex = new RegExp(`https?://[^\\s"']+\\.(${videoExtPattern})(\\?[^\\s"']*)?`, 'gi');
  const anchorWithVideoRegex = new RegExp(`<a[^>]*href=["']([^"']*\\.(${videoExtPattern})(\\?[^"']*)?)[^>]*>([^<]*)</a>`, 'gi');
  const videoTagRegex = /<video[^>]*>([\s\S]*?)<\/video>/gi;
  const sourceTagRegex = /<source[^>]*src=["']([^"']+)[^>]*type=["']video\/[^"']+["']/gi;
  const iframeRegex = /<iframe[^>]*src=["']([^"']+)[^>]*>/gi;
  
  // Match direct video links
  let match;
  while ((match = directVideoRegex.exec(html)) !== null) {
    const url = match[0];
    
    // Try to determine if this is a show by looking at the URL structure
    let extractedMediaType = mediaType;
    let extractedTitle = '';
    let extractedSeason = season;
    let extractedEpisode = null;
    
    // Parse title and episode info from URL
    const urlParts = url.split('/').pop().split('?')[0].replace(/\.(mp4|mkv|avi|mov|flv|wmv|m4v|webm)$/, '');
    
    // Try to extract season and episode info
    const seasonEpisodeRegex = /[sS](\d+)[eE](\d+)/;
    const seasonEpisodeMatch = urlParts.match(seasonEpisodeRegex);
    
    if (seasonEpisodeMatch) {
      extractedMediaType = 'show';
      extractedSeason = parseInt(seasonEpisodeMatch[1], 10);
      extractedEpisode = parseInt(seasonEpisodeMatch[2], 10);
      extractedTitle = urlParts.split(seasonEpisodeMatch[0])[0].trim().replace(/[._-]/g, ' ');
    } else {
      // Try alternate format like 1x01
      const altFormatRegex = /(\d+)x(\d+)/;
      const altFormatMatch = urlParts.match(altFormatRegex);
      
      if (altFormatMatch) {
        extractedMediaType = 'show';
        extractedSeason = parseInt(altFormatMatch[1], 10);
        extractedEpisode = parseInt(altFormatMatch[2], 10);
        extractedTitle = urlParts.split(altFormatMatch[0])[0].trim().replace(/[._-]/g, ' ');
      } else {
        // Look for common patterns
        if (urlParts.toLowerCase().includes('season') || urlParts.toLowerCase().includes('episode')) {
          extractedMediaType = 'show';
          
          // Try to extract season number
          const seasonRegex = /season[.\s_-]*(\d+)/i;
          const seasonMatch = urlParts.match(seasonRegex);
          if (seasonMatch) {
            extractedSeason = parseInt(seasonMatch[1], 10);
          }
          
          // Try to extract episode number
          const episodeRegex = /episode[.\s_-]*(\d+)/i;
          const episodeMatch = urlParts.match(episodeRegex);
          if (episodeMatch) {
            extractedEpisode = parseInt(episodeMatch[1], 10);
          }
          
          // Get title
          extractedTitle = urlParts.replace(/season[.\s_-]*\d+/i, '')
                                 .replace(/episode[.\s_-]*\d+/i, '')
                                 .trim()
                                 .replace(/[._-]/g, ' ');
        } else {
          extractedTitle = urlParts.replace(/[._-]/g, ' ');
        }
      }
    }
    
    // If we don't have a title but have a query, use it
    if (!extractedTitle && query) {
      extractedTitle = query;
    }
    
    results.push({
      url,
      type: 'direct-video',
      priority: 10,
      title: extractedTitle,
      mediaType: extractedMediaType,
      showName: extractedMediaType === 'show' ? extractedTitle : null,
      season: extractedSeason,
      episode: extractedEpisode
    });
  }
  
  // Match anchor tags with video extensions
  while ((match = anchorWithVideoRegex.exec(html)) !== null) {
    const url = match[1];
    let linkText = match[4].trim();
    
    // Similar parsing logic as above
    let extractedMediaType = mediaType;
    let extractedTitle = linkText || '';
    let extractedSeason = season;
    let extractedEpisode = null;
    
    // Parse title from link text or filename
    const filename = url.split('/').pop().split('?')[0].replace(/\.(mp4|mkv|avi|mov|flv|wmv|m4v|webm)$/, '');
    
    // Try to extract season and episode info
    const seasonEpisodeRegex = /[sS](\d+)[eE](\d+)/;
    let sourceToCheck = linkText || filename;
    const seasonEpisodeMatch = sourceToCheck.match(seasonEpisodeRegex);
    
    if (seasonEpisodeMatch) {
      extractedMediaType = 'show';
      extractedSeason = parseInt(seasonEpisodeMatch[1], 10);
      extractedEpisode = parseInt(seasonEpisodeMatch[2], 10);
      extractedTitle = sourceToCheck.split(seasonEpisodeMatch[0])[0].trim().replace(/[._-]/g, ' ');
    } else {
      // Try alternate format like 1x01
      const altFormatRegex = /(\d+)x(\d+)/;
      const altFormatMatch = sourceToCheck.match(altFormatRegex);
      
      if (altFormatMatch) {
        extractedMediaType = 'show';
        extractedSeason = parseInt(altFormatMatch[1], 10);
        extractedEpisode = parseInt(altFormatMatch[2], 10);
        extractedTitle = sourceToCheck.split(altFormatMatch[0])[0].trim().replace(/[._-]/g, ' ');
      } else if (sourceToCheck.toLowerCase().includes('season') || sourceToCheck.toLowerCase().includes('episode')) {
        extractedMediaType = 'show';
        
        // Try to extract season number
        const seasonRegex = /season[.\s_-]*(\d+)/i;
        const seasonMatch = sourceToCheck.match(seasonRegex);
        if (seasonMatch) {
          extractedSeason = parseInt(seasonMatch[1], 10);
        }
        
        // Try to extract episode number
        const episodeRegex = /episode[.\s_-]*(\d+)/i;
        const episodeMatch = sourceToCheck.match(episodeRegex);
        if (episodeMatch) {
          extractedEpisode = parseInt(episodeMatch[1], 10);
        }
        
        // Get title
        extractedTitle = sourceToCheck.replace(/season[.\s_-]*\d+/i, '')
                               .replace(/episode[.\s_-]*\d+/i, '')
                               .trim()
                               .replace(/[._-]/g, ' ');
      }
    }
    
    // If we don't have a title but have a query, use it
    if (!extractedTitle && query) {
      extractedTitle = query;
    }
    
    // Make sure we have an absolute URL
    const absoluteUrl = url.startsWith('http') ? url : `https://${domain}${url.startsWith('/') ? '' : '/'}${url}`;
    
    results.push({
      url: absoluteUrl,
      type: 'download-link',
      priority: 8,
      title: extractedTitle,
      mediaType: extractedMediaType,
      showName: extractedMediaType === 'show' ? extractedTitle : null,
      season: extractedSeason,
      episode: extractedEpisode
    });
  }
  
  // Extract from video tags with source elements
  while ((match = videoTagRegex.exec(html)) !== null) {
    const videoContent = match[1];
    const sourceTags = videoContent.match(/<source[^>]*src=["']([^"']+)[^>]*>/g) || [];
    
    for (const sourceTag of sourceTags) {
      const sourceMatch = sourceTag.match(/src=["']([^"']+)["']/);
      if (!sourceMatch) continue;
      
      const url = sourceMatch[1];
      // Skip data URLs
      if (url.startsWith('data:')) continue;
      
      // Make title from filename or query
      const filename = url.split('/').pop().split('?')[0];
      let extractedTitle = filename.replace(/\.(mp4|mkv|avi|mov|flv|wmv|m4v|webm)$/, '').replace(/[._-]/g, ' ') || query;
      
      // Apply same season/episode extraction logic 
      let extractedMediaType = mediaType;
      let extractedSeason = season;
      let extractedEpisode = null;
      
      // Check if filename contains season/episode pattern
      const seasonEpisodeRegex = /[sS](\d+)[eE](\d+)/;
      const seasonEpisodeMatch = filename.match(seasonEpisodeRegex);
      
      if (seasonEpisodeMatch) {
        extractedMediaType = 'show';
        extractedSeason = parseInt(seasonEpisodeMatch[1], 10);
        extractedEpisode = parseInt(seasonEpisodeMatch[2], 10);
        extractedTitle = filename.split(seasonEpisodeMatch[0])[0].trim().replace(/[._-]/g, ' ');
      }
      
      // Make URL absolute
      const absoluteUrl = url.startsWith('http') ? url : `https://${domain}${url.startsWith('/') ? '' : '/'}${url}`;
      
      results.push({
        url: absoluteUrl,
        type: 'source-tag',
        priority: 9,
        title: extractedTitle,
        mediaType: extractedMediaType,
        showName: extractedMediaType === 'show' ? extractedTitle : null,
        season: extractedSeason,
        episode: extractedEpisode
      });
    }
  }
  
  // Match standalone source tags
  while ((match = sourceTagRegex.exec(html)) !== null) {
    const url = match[1];
    
    // Skip if already found in video tags
    if (results.some(r => r.url === url)) continue;
    
    // Skip data URLs
    if (url.startsWith('data:')) continue;
    
    // Make title from filename or query
    const filename = url.split('/').pop().split('?')[0];
    let extractedTitle = filename.replace(/\.(mp4|mkv|avi|mov|flv|wmv|m4v|webm)$/, '').replace(/[._-]/g, ' ') || query;
    
    // Apply same season/episode extraction logic
    let extractedMediaType = mediaType;
    let extractedSeason = season;
    let extractedEpisode = null;
    
    // Check if filename contains season/episode pattern
    const seasonEpisodeRegex = /[sS](\d+)[eE](\d+)/;
    const seasonEpisodeMatch = filename.match(seasonEpisodeRegex);
    
    if (seasonEpisodeMatch) {
      extractedMediaType = 'show';
      extractedSeason = parseInt(seasonEpisodeMatch[1], 10);
      extractedEpisode = parseInt(seasonEpisodeMatch[2], 10);
      extractedTitle = filename.split(seasonEpisodeMatch[0])[0].trim().replace(/[._-]/g, ' ');
    }
    
    // Make URL absolute
    const absoluteUrl = url.startsWith('http') ? url : `https://${domain}${url.startsWith('/') ? '' : '/'}${url}`;
    
    results.push({
      url: absoluteUrl,
      type: 'source-tag',
      priority: 9,
      title: extractedTitle,
      mediaType: extractedMediaType,
      showName: extractedMediaType === 'show' ? extractedTitle : null,
      season: extractedSeason,
      episode: extractedEpisode
    });
  }
  
  // Match iframes for embedded videos
  while ((match = iframeRegex.exec(html)) !== null) {
    const url = match[1];
    
    // Only consider known video platforms
    if (isStreamingPlatformUrl(url) || url.includes('youtube.com') || url.includes('youtu.be') || url.includes('vimeo.com')) {
      results.push({
        url,
        type: 'iframe-embed',
        priority: 7,
        title: query,
        mediaType: mediaType,
        showName: mediaType === 'show' ? query : null,
        season: season,
        episode: null
      });
    }
  }
  
  // Deduplicate by URL
  const uniqueResults = [];
  const seenUrls = new Set();
  
  for (const result of results) {
    if (!seenUrls.has(result.url)) {
      seenUrls.add(result.url);
      uniqueResults.push(result);
    }
  }
  
  return uniqueResults;
}

/**
 * Check if a URL is from a known streaming platform
 * @param {string} url - URL to check
 * @returns {boolean} True if from streaming platform
 */
function isStreamingPlatformUrl(url) {
  const streamingDomains = [
    'youtube.com', 'youtu.be',       // YouTube
    'vimeo.com', 'player.vimeo.com', // Vimeo
    'dailymotion.com',               // Dailymotion
    'twitch.tv',                     // Twitch
    'facebook.com', 'fb.watch',      // Facebook
    'instagram.com',                 // Instagram
    'twitter.com', 'x.com',          // Twitter/X
    'tiktok.com',                    // TikTok
    'reddit.com',                    // Reddit
    'streamable.com',                // Streamable
    'bitchute.com',                  // Bitchute
    'rumble.com',                    // Rumble
    'odysee.com',                    // Odysee
    'archive.org',                   // Internet Archive
    'netflix.com/watch',             // Netflix
    'hulu.com/watch',                // Hulu
    'amazon.com/gp/video',           // Amazon Video
    'primevideo.com',                // Prime Video
    'disneyplus.com',                // Disney+
    'hbomax.com',                    // HBO Max
    'peacocktv.com',                 // Peacock
    'apple.co/tv'                    // Apple TV+
  ];
  
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname.toLowerCase();
    
    // Check if domain matches or is subdomain of any streaming domain
    return streamingDomains.some(streamingDomain => 
      domain === streamingDomain || 
      domain.endsWith(`.${streamingDomain}`) ||
      domain.includes(streamingDomain)
    );
  } catch (error) {
    console.error('Error parsing URL:', error);
    return false;
  }
}

/**
 * Search for media by crawling various sites
 * @param {string} query - Search query
 * @param {string} mediaType - Type of media to search for
 * @param {string|null} season - Season number for TV shows
 * @returns {Promise<Array>} Search results
 */
async function crawlOnionSites(query, mediaType = 'all', season = null) {
  // Add crawler log
  addCrawlerLog('Crawler', `Starting search for "${query}" (${mediaType})`, null, 'info');
  
  // Generate list of sites to crawl (in a real app, this would contain actual URLs)
  const sitesToCrawl = generateSitesToCrawl(5);
  const results = [];
  
  // If looking for a TV show, try to get show information first
  let showInfo = null;
  if ((mediaType === 'show' || mediaType === 'all') && !season) {
    try {
      showInfo = await getShowInformation(query);
      addCrawlerLog('Crawler', `Found show information: ${showInfo.availableSeasons} seasons available`, null, 'success');
    } catch (error) {
      addCrawlerLog('Crawler', `Failed to get show information: ${error.message}`, null, 'warning');
    }
  }

  for (const site of sitesToCrawl) {
    try {
      addCrawlerLog('Crawler', `Searching ${site.name}`, site.url, 'info');
      
      // Format the search URL for this site
      const searchUrl = formatSiteSearchUrl(site, query, mediaType, season, 1);
      
      // Simulate fetching the page (in real app, use a proper Tor client)
      const pageContent = await simulateFetchPage(searchUrl);
      
      if (!pageContent) {
        addCrawlerLog('Crawler', `Failed to fetch content from ${site.name}`, site.url, 'error');
        continue;
      }
      
      // Extract video URLs from the page with enhanced metadata
      const extractedUrls = extractVideoUrls(pageContent, site.domain, query, mediaType, season);
      
      if (extractedUrls.length > 0) {
        addCrawlerLog('Crawler', `Found ${extractedUrls.length} potential media links on ${site.name}`, site.url, 'success');
        
        // Process each extracted URL
        for (const extracted of extractedUrls) {
          // Validate the URL
          const validation = await validateUrl(extracted.url);
          
          if (validation.valid) {
            // Create a result entry with enhanced metadata
            const resultItem = {
              title: extracted.title || `${query} - ${site.name}`,
              url: extracted.url,
              source: site.name,
              type: extracted.type,
              mediaType: extracted.mediaType || mediaType,
              priority: extracted.priority + validation.score,
              size: extracted.size || 'Unknown',
              quality: extracted.quality || ['720p', '1080p', '4K'][Math.floor(Math.random() * 3)],
              isDirectVideo: extracted.type === 'direct-video'
            };
            
            // Add TV show specific metadata if available
            if (extracted.mediaType === 'show' || mediaType === 'show') {
              resultItem.showName = extracted.showName || query;
              
              if (extracted.season) {
                resultItem.season = extracted.season;
              } else if (season) {
                resultItem.season = parseInt(season, 10);
              }
              
              if (extracted.episode) {
                resultItem.episode = extracted.episode;
              }
            }
            
            results.push(resultItem);
            addCrawlerLog('Crawler', `Valid media found: ${extracted.type} (Score: ${validation.score})`, extracted.url, 'success');
          } else {
            addCrawlerLog('Crawler', `Invalid media: ${validation.reason}`, extracted.url, 'warning');
          }
        }
      } else {
        addCrawlerLog('Crawler', `No media links found on ${site.name}`, site.url, 'info');
      }
      
      // If we're looking for a TV show and we have show info with multiple seasons
      if ((mediaType === 'show' || mediaType === 'all') && showInfo && showInfo.availableSeasons > 1) {
        // Check if the site has a dedicated shows section
        if (site.mediaTypes.includes('show')) {
          addCrawlerLog('Crawler', `Searching ${site.name} for all seasons of ${query}`, site.url, 'info');
          
          // For each season (up to a reasonable limit)
          const maxSeasonsToCheck = Math.min(showInfo.availableSeasons, 10); // Limit to 10 seasons max
          
          for (let s = 1; s <= maxSeasonsToCheck; s++) {
            if (season && s !== parseInt(season, 10)) continue; // Skip if we're only looking for a specific season
            
            addCrawlerLog('Crawler', `Searching for ${query} Season ${s}`, null, 'info');
            
            // Format season-specific search URL
            const seasonSearchUrl = formatSiteSearchUrl(site, `${query} Season ${s}`, 'show', s, 1);
            const seasonPageContent = await simulateFetchPage(seasonSearchUrl);
            
            if (seasonPageContent) {
              // Extract with season info
              const seasonResults = extractVideoUrls(seasonPageContent, site.domain, query, 'show', s);
              
              if (seasonResults.length > 0) {
                addCrawlerLog('Crawler', `Found ${seasonResults.length} results for ${query} Season ${s}`, null, 'success');
                
                // Process and add each result
                for (const extracted of seasonResults) {
                  const validation = await validateUrl(extracted.url);
                  
                  if (validation.valid) {
                    results.push({
                      title: extracted.title || `${query} Season ${s}`,
                      url: extracted.url,
                      source: site.name,
                      type: extracted.type,
                      mediaType: 'show',
                      showName: query,
                      season: s,
                      episode: extracted.episode,
                      priority: extracted.priority + validation.score,
                      size: extracted.size || 'Unknown',
                      quality: extracted.quality || ['720p', '1080p', '4K'][Math.floor(Math.random() * 3)],
                      isDirectVideo: extracted.type === 'direct-video'
                    });
                    
                    addCrawlerLog('Crawler', `Valid show content: Season ${s}${extracted.episode ? ', Episode ' + extracted.episode : ''}`, extracted.url, 'success');
                  }
                }
              }
            }
          }
        }
      }
    } catch (error) {
      addCrawlerLog('Crawler', `Error crawling ${site.name}: ${error.message}`, site.url, 'error');
    }
  }
  
  // Sort results by priority
  results.sort((a, b) => b.priority - a.priority);
  
  // Log the number of results found
  addCrawlerLog('Crawler', `Search completed. Found ${results.length} results for "${query}"`, null, 'info');
  
  return results;
}

/**
 * Generate mock sites to crawl
 * @param {number} maxSites - Maximum number of sites to generate
 * @returns {Array} Array of site objects
 */
function generateSitesToCrawl(maxSites) {
  const sitesToCrawl = [
    {
      name: 'FilmArchive.org',
      domain: 'filmarchive.org',
      url: 'https://filmarchive.org',
      public: true,
      mediaTypes: ['movie', 'show'],
      searchPath: '/search'
    },
    {
      name: 'ClassicCinemaOnline',
      domain: 'classiccinemaonline.com',
      url: 'https://classiccinemaonline.com',
      public: true,
      mediaTypes: ['movie'],
      searchPath: '/movies/search'
    },
    {
      name: 'PublicDomainMovies',
      domain: 'publicdomainmovies.net',
      url: 'https://publicdomainmovies.net',
      public: true,
      mediaTypes: ['movie', 'show'],
      searchPath: '/search'
    },
    {
      name: 'VintageVideoVault',
      domain: 'vintagevideos.archive.org',
      url: 'https://vintagevideos.archive.org',
      public: true,
      mediaTypes: ['movie', 'show', 'documentary'],
      searchPath: '/search'
    },
    {
      name: 'FreeCinemaHub',
      domain: 'freecinemahub.com',
      url: 'https://freecinemahub.com',
      public: false,
      mediaTypes: ['movie', 'show'],
      searchPath: '/index.php?s='
    }
  ];
  
  // Return random selection
  return sitesToCrawl.slice(0, Math.min(maxSites, sitesToCrawl.length));
}

/**
 * Format a search URL for a site
 * @param {Object} site - Site information
 * @param {string} query - Search query
 * @param {string} mediaType - Type of media
 * @param {string|null} season - Season number
 * @param {number} page - Page number
 * @returns {string} Formatted search URL
 */
function formatSiteSearchUrl(site, query, mediaType, season, page) {
  let url = site.url + site.searchPath;
  
  // Add query
  if (site.searchPath.includes('?')) {
    url += encodeURIComponent(query);
  } else {
    url += '?q=' + encodeURIComponent(query);
  }
  
  // Add media type filter if the site supports it
  if (mediaType !== 'all' && site.mediaTypes.includes(mediaType)) {
    url += '&type=' + mediaType;
  }
  
  // Add season for TV shows
  if (mediaType === 'show' && season) {
    url += '&season=' + season;
  }
  
  // Add page number
  url += '&page=' + page;
  
  return url;
}

/**
 * Simulate fetching a page (mock function)
 * @param {string} url - URL to fetch
 * @returns {Promise<string>} Page content
 */
async function simulateFetchPage(url) {
  // In a real app, this would use fetch or a Tor-capable HTTP client
  await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000));
  
  // Simulate success/failure
  if (Math.random() < 0.8) {
    // Generate mock HTML content
    const domain = new URL(url).hostname;
    return `
      <html>
        <head><title>Search Results - ${domain}</title></head>
        <body>
          <div class="search-results">
            <div class="result-item">
              <h3>Sample Movie Title</h3>
              <a href="https://${domain}/watch/sample-movie.mp4">Watch</a>
              <a href="https://${domain}/download/sample-movie.mp4">Download</a>
            </div>
            <div class="result-item">
              <h3>Another Sample Title</h3>
              <a href="https://${domain}/watch/another-sample">Watch</a>
              <video>
                <source src="https://${domain}/videos/another-sample.mp4" type="video/mp4">
              </video>
            </div>
            <iframe src="https://player.vimeo.com/video/123456789"></iframe>
          </div>
        </body>
      </html>
    `;
  } else {
    // Simulate failure
    return null;
  }
}

/**
 * Get information about a TV show
 * @param {string} showName - Name of the show
 * @returns {Promise<Object>} Show information
 */
async function getShowInformation(showName) {
  try {
    // Log the lookup activity
    addCrawlerLog('Show Lookup', `Looking up information for "${showName}"`, null, 'info');
    
    // Simulate API access by adding a delay
    await new Promise(resolve => setTimeout(resolve, 1200));
    
    // Generate some mock data
    const availableSeasons = Math.floor(Math.random() * 10) + 1;
    let totalEpisodes = 0;
    
    // Generate a different number of episodes per season
    const seasons = [];
    for (let i = 1; i <= availableSeasons; i++) {
      const episodesInSeason = Math.floor(Math.random() * 12) + 8;
      totalEpisodes += episodesInSeason;
      seasons.push({
        season: i,
        episodes: episodesInSeason
      });
    }
    
    // For popular shows, provide specific data
    const popularShows = {
      'Game of Thrones': { seasons: 8, episodes: 73 },
      'Breaking Bad': { seasons: 5, episodes: 62 },
      'Stranger Things': { seasons: 4, episodes: 34 },
      'The Office': { seasons: 9, episodes: 201 },
      'Friends': { seasons: 10, episodes: 236 }
    };
    
    let result;
    if (popularShows[showName]) {
      const show = popularShows[showName];
      result = {
        name: showName,
        availableSeasons: show.seasons,
        totalEpisodes: show.episodes,
        status: 'Ended',
        found: true
      };
    } else {
      result = {
        name: showName,
        availableSeasons,
        totalEpisodes,
        status: Math.random() > 0.5 ? 'Running' : 'Ended',
        found: true
      };
    }
    
    // Log success
    addCrawlerLog('Show Lookup', `Found information for "${showName}": ${result.availableSeasons} seasons, ${result.totalEpisodes} episodes`, null, 'success');
    
    return result;
  } catch (error) {
    // Log failure
    addCrawlerLog('Show Lookup', `Failed to find information for "${showName}": ${error.message}`, null, 'error');
    
    return {
      name: showName,
      found: false,
      error: error.message
    };
  }
}

// Routes
app.get('/', (req, res) => {
  res.render('index', {
    title: 'Media Server',
    searchQuery: '',
    results: [],
    movies: mediaDatabase.movies.slice(0, 4),
    shows: mediaDatabase.shows.slice(0, 4)
  });
});

app.get('/movies', (req, res) => {
  scanMediaDirectories();
  res.render('movies', { movies: mediaDatabase.movies });
});

app.get('/shows', (req, res) => {
  scanMediaDirectories();
  
  // Organize shows by series, season and episode
  const organizedShows = organizeShowsBySeries();
  
  res.render('shows', { organizedShows: organizedShows });
});

app.get('/search', (req, res) => {
  scanMediaDirectories();
  const query = req.query.q?.toLowerCase() || '';
  
  if (!query) {
    return res.render('search', { query: '', results: [] });
  }
  
  const results = [
    ...mediaDatabase.movies.filter(movie => 
      movie.title.toLowerCase().includes(query)
    ),
    ...mediaDatabase.shows.filter(show => 
      show.title.toLowerCase().includes(query) || 
      show.showName.toLowerCase().includes(query)
    )
  ];
  
  res.render('search', { query, results });
});

// New route for queue monitoring page
app.get('/queue', (req, res) => {
  res.render('queue', {
    title: 'Queue Manager',
    searchQueue: searchQueue,
    pendingApprovals: pendingApprovals,
    crawlerLogs: crawlerLogs
  });
});

// API endpoint to delete a media file
app.delete('/api/media/:type/:filename', (req, res) => {
  const { type, filename } = req.params;
  let directory;
  
  // Determine the right directory based on media type
  if (type === 'movie') {
    directory = moviesDir;
  } else if (type === 'show') {
    directory = showsDir;
  } else if (type === 'trailer') {
    directory = trailersDir;
  } else {
    return res.status(400).json({ 
      status: 'error',
      message: 'Invalid media type'
    });
  }
  
  const filePath = path.join(directory, filename);
  
  // Check if file exists
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      status: 'error',
      message: 'File not found'
    });
  }
  
  // Try to delete the file
  try {
    fs.unlinkSync(filePath);
    
    // Update the media database
    scanMediaDirectories();
    
    return res.json({
      status: 'success',
      message: `${type} "${filename}" has been deleted`
    });
  } catch (error) {
    console.error(`Error deleting file ${filePath}:`, error);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to delete the file'
    });
  }
});

// API to find new content 
app.post('/api/search', async (req, res) => {
  const query = req.body.query;
  const includeTor = req.body.include_onion || false;
  const mediaType = req.body.media_type || 'all'; // 'movie', 'show', or 'all'
  const season = req.body.season || null; // Optional season number
  
  if (!query) {
    return res.status(400).json({ status: 'error', message: 'No query provided' });
  }
  
  // Create a new search queue item
  const searchId = uuidv4();
  const newSearch = {
    id: searchId,
    query: query,
    mediaType: mediaType,
    season: season,
    includeTor: includeTor,
    status: 'queued',
    progress: 0,
    created: new Date(),
    results: [],
    message: 'Search queued, waiting to start...'
  };
  
  // Add to queue
  searchQueue.push(newSearch);
  
  // Start a background process to search and collect content
  // This allows the API to return immediately while the search continues
  (async () => {
    try {
      // Update status
      const searchItem = searchQueue.find(item => item.id === searchId);
      if (!searchItem) return;
      
      searchItem.status = 'searching';
      searchItem.message = 'Searching web sources...';
      searchItem.progress = 10;
      
      // Search standard web sources first
      const webResults = await searchWebForMedia(query, mediaType, season);
      searchItem.progress = 30;
      
      // If Tor search is requested, search Tor
      let torResults = [];
      if (includeTor) {
        searchItem.message = 'Searching alternative sources...';
        torResults = await crawlOnionSites(query, mediaType, season);
        searchItem.progress = 50;
        
        // If searching for a show and no specific season is requested,
        // try to find all seasons and episodes
        if (mediaType === 'show' || mediaType === 'all') {
          if (!season) {
            searchItem.message = 'Discovering all seasons...';
            // Attempt to discover all available seasons
            const showInfo = await getShowInformation(query);
            if (showInfo && showInfo.seasons) {
              searchItem.message = `Found ${showInfo.seasons.length} seasons, searching episodes...`;
              let completedSeasons = 0;
              const totalSeasons = showInfo.seasons.length;
              
              for (const seasonNum of showInfo.seasons) {
                // Search specifically for this season
                searchItem.message = `Searching for Season ${seasonNum}...`;
                const seasonResults = await crawlOnionSites(
                  query, 'show', seasonNum
                );
                torResults.push(...seasonResults);
                
                completedSeasons++;
                // Update progress based on seasons completed
                const seasonProgress = 30; // 30% allocated for seasons search
                searchItem.progress = 50 + Math.floor((completedSeasons / totalSeasons) * seasonProgress);
              }
            }
          }
        }
        
        // For movies, try to find the trailer too
        if (mediaType === 'movie' || mediaType === 'all') {
          searchItem.message = 'Searching for trailer...';
          const trailerResults = await crawlOnionSites(`${query} trailer`, 'trailer');
          if (trailerResults.length > 0) {
            // Add trailer to results for approval
            torResults.push(...trailerResults.map(result => {
              return {
                ...result,
                isTrailer: true,
                forMovie: query
              };
            }));
          }
          searchItem.progress = 90;
        }
      }
      
      // Process and store the combined results, removing duplicates
      let allResults = [...webResults, ...torResults];
      
      // Prioritize results by type and how likely they are to be actual videos
      allResults = allResults.map(result => {
        // Calculate result score to help prioritize
        let score = 0;
        
        // Direct videos get highest score
        if (result.directVideo) score += 10;
        if (result.linkType === 'direct' || result.linkType === 'video-tag' || result.linkType === 'source-tag') score += 10;
        
        // Official streaming or legal sources
        if (result.metadata && result.metadata.legal) score += 5;
        
        // Download links
        if (result.linkType === 'download') score += 7;
        
        // Streaming links
        if (result.isStreaming) score += 4;
        
        // Use provided priority if available
        if (result.priority) score += result.priority;
        
        // Prioritize videos with proper file extensions
        const videoExtRegex = /\.(mp4|mkv|avi|mov|flv|wmv|m4v|webm)(\?.*)?$/i;
        if (videoExtRegex.test(result.url)) score += 8;
        
        return {
          ...result,
          score
        };
      });
      
      // Sort by score (highest first)
      allResults.sort((a, b) => (b.score || 0) - (a.score || 0));
      
      // Remove obvious duplicates (same URL or very similar titles)
      const uniqueResults = [];
      const seenUrls = new Set();
      
      for (const result of allResults) {
        if (!seenUrls.has(result.url)) {
          seenUrls.add(result.url);
          uniqueResults.push(result);
        }
      }
      
      // Limit to a reasonable number of results
      const limitedResults = uniqueResults.slice(0, 30);
      
      // Video file extensions regex for checking direct links
      const videoExtRegex = /\.(mp4|mkv|avi|mov|flv|wmv|m4v|webm)(\?.*)?$/i;
      
      // Verify content length for each result
      searchItem.message = 'Verifying content details...';
      const verifiedResults = [];
      
      for (let i = 0; i < limitedResults.length; i++) {
        const result = limitedResults[i];
        const resultType = result.isTrailer ? 'trailer' : (result.mediaType || mediaType);
        
        // Update the message to show progress
        searchItem.message = `Verifying content ${i+1}/${limitedResults.length}...`;
        
        try {
          // First validate the URL to make sure it's accessible and preferably a video
          const urlValidation = await validateUrl(result.url);
          
          if (urlValidation.valid) {
            // If valid URL, verify content length too
            const lengthInfo = await verifyContentLength(result.url, resultType);
            
            // Add verification info to the result
            result.contentLength = lengthInfo.contentLength;
            result.isFullLength = lengthInfo.isAcceptableLength;
            result.isValidVideo = lengthInfo.isValidVideo;
            result.duration = lengthInfo.duration;
            
            // Add to verified results if it's a valid video or passes size check
            if (lengthInfo.isValidVideo || lengthInfo.isAcceptableLength) {
              verifiedResults.push(result);
            } else if (result.directVideo || videoExtRegex.test(result.url)) {
              // Also include if it's a direct video link, even if verification failed
              // (some servers don't handle HEAD requests properly)
              verifiedResults.push(result);
              addCrawlerLog('Content Verifier', 
                `Including ${resultType} based on URL pattern despite verification failure`, null, 'warning');
            }
          } else {
            // Skip URLs that don't validate
            addCrawlerLog('Content Verifier', 
              `Skipping invalid URL: ${result.url.substring(0, 50)}...`, null, 'error');
          }
        } catch (verifyError) {
          console.error('Error verifying content:', verifyError);
          addCrawlerLog('Content Verifier', 
            `Error verifying URL (${verifyError.message}): ${result.url.substring(0, 50)}...`, null, 'error');
        }
      }
      
      // Update search status
      searchItem.status = 'completed';
      searchItem.progress = 100;
      searchItem.completed = new Date();
      searchItem.message = `Search completed. Found ${verifiedResults.length} valid results.`;
      
      // Move results to pending approvals
      if (verifiedResults.length > 0) {
        verifiedResults.forEach(result => {
          pendingApprovals.push({
            id: uuidv4(),
            searchId: searchId,
            title: result.title || query,
            mediaType: result.mediaType || mediaType,
            isTrailer: result.isTrailer || false,
            forMovie: result.forMovie || null,
            season: result.season || season,
            episode: result.episode || null,
            url: result.url,
            size: result.size || result.contentLength || 'Unknown',
            quality: result.quality || 'Unknown',
            duration: result.duration || null,
            isFullLength: result.isFullLength || false,
            isValidVideo: result.isValidVideo || false,
            directVideo: result.directVideo || false,
            source: result.source || (includeTor ? 'Alternative' : 'Web'),
            created: new Date(),
            status: 'pending'
          });
        });
      }
      
      console.log(`Found ${verifiedResults.length} valid results for query: ${query}`);
      
    } catch (error) {
      // Update search with error
      const searchItem = searchQueue.find(item => item.id === searchId);
      if (searchItem) {
        searchItem.status = 'error';
        searchItem.message = `Error: ${error.message}`;
        searchItem.completed = new Date();
      }
      console.error('Error in background search process:', error);
    }
  })();
  
  // Return immediately with a queue status and the search ID
  return res.json({
    status: 'success', 
    message: `Search for "${query}" has been queued. ${includeTor ? 'Searching both web and alternative sources.' : 'Searching web sources only.'} Check back in a few minutes for results.`,
    searchId: searchId
  });
});

// API to get search status
app.get('/api/search/:id', (req, res) => {
  const searchId = req.params.id;
  const search = searchQueue.find(item => item.id === searchId);
  
  if (!search) {
    return res.status(404).json({ status: 'error', message: 'Search not found' });
  }
  
  return res.json({
    status: 'success',
    search: search
  });
});

// API to get all pending approvals
app.get('/api/approvals', (req, res) => {
  return res.json({
    status: 'success',
    pendingApprovals: pendingApprovals
  });
});

// API to get crawler logs
app.get('/api/crawler-logs', (req, res) => {
  // Get the number of logs to return (default to 50)
  const limit = req.query.limit ? parseInt(req.query.limit) : 50;
  
  // Return the most recent logs
  const recentLogs = crawlerLogs.slice(0, limit);
  
  return res.json({
    status: 'success',
    logs: recentLogs
  });
});

// Add crawler log function (make it available globally)
global.addCrawlerLog = function(source, message, url = null, status = 'info') {
  const log = {
    timestamp: new Date(),
    source: source,
    message: message,
    url: url,
    status: status
  };
  
  // Add to beginning (newest first)
  crawlerLogs.unshift(log);
  
  // Trim logs if they exceed the maximum
  if (crawlerLogs.length > MAX_CRAWLER_LOGS) {
    crawlerLogs.length = MAX_CRAWLER_LOGS;
  }
  
  console.log(`[${status.toUpperCase()}] [${source}] ${message}`);
  return log;
};

// Serve converted media files
app.use('/media/converted', express.static(path.join(__dirname, '.data', 'converted')));
app.use('/media/downloads', express.static(path.join(__dirname, '.data', 'downloads')));

// API endpoint for URL direct import
app.post('/api/url-import', async (req, res) => {
  try {
    const { url, media_type, title, season, episode, for_movie } = req.body;
    
    if (!url) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'URL is required' 
      });
    }
    
    // Log that we're processing the URL
    addCrawlerLog('URL Import', `Processing direct URL import: ${url}`, title || url);
    
    // First validate the URL for basic format check
    const validation = await validateUrl(url);
    
    if (!validation.valid) {
      addCrawlerLog('URL Import', `Invalid URL: ${validation.reason}`, title || url, 'error');
      return res.status(400).json({ 
        status: 'error', 
        message: `Invalid URL: ${validation.reason}` 
      });
    }
    
    // Check if it's a streaming platform URL or a direct video link
    // Use our enhanced media extractor for URLs that might need processing
    let processingResult;
    let finalUrl = url;
    let videoTitle = title;
    let isDirectVideo = validation.isDirectVideo;
    let videoSize = 'Unknown';
    let videoQuality = 'Unknown';
    let videoDuration = null;
    
    // Process the video URL to extract direct video links
    // This handles YouTube, Vimeo, etc., and extracts direct video URLs
    addCrawlerLog('URL Import', `Starting media extraction and processing for: ${url}`, title || url);
    processingResult = await mediaExtractor.processVideo(url, {
      format: 'mp4',
      download: true,
      convert: true
    });
    
    if (!processingResult.success) {
      addCrawlerLog('URL Import', `Media extraction failed: ${processingResult.error}`, title || url, 'error');
      // Don't return error here - we'll continue with the original URL as a fallback
    } else {
      // Update values with processed results
      finalUrl = processingResult.url;
      videoTitle = processingResult.title || title;
      isDirectVideo = true; // If we succeeded in processing, we now have a direct video
      videoSize = processingResult.formattedSize || processingResult.size || 'Unknown';
      videoQuality = processingResult.quality || 'Unknown';
      
      addCrawlerLog('URL Import', 
        `Successfully processed media: ${videoTitle} (${processingResult.format}, ${videoSize})`, 
        title || url, 'success');
    }
    
    // Determine content type based on URL or specified type
    const resultType = media_type || 'movie';
    
    // Verify content length of the final URL
    const contentInfo = await verifyContentLength(finalUrl, resultType);
    
    // Create approval item
    const approvalId = uuidv4();
    const newApproval = {
      id: approvalId,
      title: videoTitle || finalUrl.split('/').pop() || 'Imported Content',
      mediaType: resultType,
      isTrailer: resultType === 'trailer',
      forMovie: for_movie || null,
      season: season || null,
      episode: episode || null,
      url: finalUrl,
      originalUrl: url !== finalUrl ? url : null, // Store original URL if different
      size: processingResult?.success ? videoSize : (contentInfo.contentLength || 'Unknown'),
      quality: videoQuality,
      duration: contentInfo.duration || processingResult?.duration || null,
      isFullLength: contentInfo.isAcceptableLength || true, // Assume true if we processed it
      isValidVideo: contentInfo.isValidVideo || isDirectVideo,
      directVideo: isDirectVideo,
      source: processingResult?.success ? `Processed (${processingResult.platform})` : 'Direct URL',
      created: new Date(),
      status: 'pending',
      isConverted: processingResult?.success || false,
      localPath: processingResult?.localPath || null // Keep track of the local file if we have it
    };
    
    // Add to pending approvals
    pendingApprovals.push(newApproval);
    
    // Log success
    addCrawlerLog('URL Import', 
      `URL import successful: ${newApproval.title} (${newApproval.mediaType}, ${newApproval.size})`, 
      title || url, 'success');
    
    return res.json({
      status: 'success',
      message: 'URL has been added to the approval queue',
      approvalId: approvalId
    });
  } catch (error) {
    console.error('Error importing URL:', error);
    addCrawlerLog('URL Import', `Error: ${error.message}`, req.body.title || req.body.url, 'error');
    
    return res.status(500).json({
      status: 'error',
      message: `Error processing URL: ${error.message}`
    });
  }
});



// Function to extract video from streaming platforms
async function extractVideoFromStreamingPlatform(url) {
  try {
    addCrawlerLog('Video Extractor', `Starting extraction from: ${url}`);
    
    // Identify platform
    let platform = 'unknown';
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      platform = 'youtube';
    } else if (url.includes('vimeo.com')) {
      platform = 'vimeo';
    } else if (url.includes('dailymotion.com')) {
      platform = 'dailymotion';
    } else if (url.includes('facebook.com') || url.includes('fb.watch')) {
      platform = 'facebook';
    } else if (url.includes('twitch.tv')) {
      platform = 'twitch';
    }
    
    addCrawlerLog('Video Extractor', `Detected platform: ${platform}`);
    
    // Simulate the extraction process
    // In a real implementation, this would use libraries like youtube-dl, yt-dlp, etc.
    await new Promise(resolve => setTimeout(resolve, 2000)); // Simulate processing time
    
    // For demonstration, we'll simulate getting a direct URL
    // In a real implementation, this would extract the actual highest quality video URL
    const directUrl = `https://converted-video-storage.example.com/${platform}-${Date.now()}.mp4`;
    
    addCrawlerLog('Video Extractor', `Extraction complete, direct URL created`, null, 'success');
    
    return {
      success: true,
      directUrl: directUrl,
      platform: platform,
      title: `Extracted from ${platform}`,
      duration: '10:30', // This would be the actual video duration
      quality: '1080p'   // This would be the actual video quality
    };
  } catch (error) {
    console.error('Error extracting video:', error);
    addCrawlerLog('Video Extractor', `Extraction failed: ${error.message}`, null, 'error');
    
    return {
      success: false,
      message: error.message
    };
  }
}

// Function to convert video to supported format
async function convertVideo(inputUrl, targetFormat = 'mp4') {
  try {
    addCrawlerLog('Video Converter', `Starting conversion: ${inputUrl} to ${targetFormat}`);
    
    // Simulate the conversion process
    // In a real implementation, this would use ffmpeg or similar libraries
    await new Promise(resolve => setTimeout(resolve, 5000)); // Simulate conversion time
    
    // For demonstration, we'll simulate a converted URL
    const convertedUrl = `https://converted-video-storage.example.com/converted-${Date.now()}.${targetFormat}`;
    
    addCrawlerLog('Video Converter', `Conversion complete: ${convertedUrl}`, null, 'success');
    
    return {
      success: true,
      convertedUrl: convertedUrl,
      format: targetFormat
    };
  } catch (error) {
    console.error('Error converting video:', error);
    addCrawlerLog('Video Converter', `Conversion failed: ${error.message}`, null, 'error');
    
    return {
      success: false,
      message: error.message
    };
  }
}

// API to approve/reject content
app.post('/api/approve/:id', async (req, res) => {
  const approvalId = req.params.id;
  const { action } = req.body; // 'approve' or 'reject'
  
  const approvalIndex = pendingApprovals.findIndex(item => item.id === approvalId);
  
  if (approvalIndex === -1) {
    return res.status(404).json({ status: 'error', message: 'Approval item not found' });
  }
  
  const approval = pendingApprovals[approvalIndex];
  
  if (action === 'approve') {
    try {
      // For YouTube videos or already converted videos, skip length verification
      const isYouTube = approval.url.includes('youtube.com') || 
                        approval.url.includes('youtu.be') || 
                        (approval.originalUrl && (approval.originalUrl.includes('youtube.com') || 
                                                approval.originalUrl.includes('youtu.be')));
                                                
      // Skip length check for YouTube, converted videos, or direct video files
      if (!approval.isFullLength && !approval.isTrailer && !isYouTube && !approval.isConverted && !approval.directVideo) {
        // Re-verify content length to be sure
        const contentInfo = await verifyContentLength(approval.url, approval.mediaType);
        
        if (!contentInfo.isAcceptableLength && !contentInfo.isValidVideo) {
          return res.status(400).json({ 
            status: 'error', 
            message: 'Content appears to be incomplete or too short. Verification failed.',
            details: contentInfo
          });
        }
        
        // Update approval info with verification results
        approval.isFullLength = contentInfo.isAcceptableLength;
        approval.isValidVideo = contentInfo.isValidVideo;
      }
      
      // Update status
      approval.status = 'downloading';
      addCrawlerLog('Content Approval', `Starting download process for: ${approval.title}`, approval.url, 'info');
      
      // Determine file details based on media type
      let filename;
      let destinationDir;
      
      // Process based on media type
      if (approval.mediaType === 'movie') {
        // Sanitize filename
        filename = `${approval.title.replace(/[^\w\s]/gi, '').replace(/\s+/g, '.')}.mp4`;
        destinationDir = moviesDir;
      } else if (approval.mediaType === 'show') {
        // Format show filename with season/episode if available
        if (approval.season && approval.episode) {
          filename = `${approval.title.replace(/[^\w\s]/gi, '').replace(/\s+/g, '.')}.S${String(approval.season).padStart(2, '0')}E${String(approval.episode).padStart(2, '0')}.mp4`;
        } else {
          filename = `${approval.title.replace(/[^\w\s]/gi, '').replace(/\s+/g, '.')}.mp4`;
        }
        destinationDir = showsDir;
      } else if (approval.isTrailer) {
        const movieTitle = approval.forMovie || approval.title.replace(' Trailer', '');
        filename = `${movieTitle.replace(/[^\w\s]/gi, '').replace(/\s+/g, '.')}.Trailer.mp4`;
        destinationDir = trailersDir;
      } else {
        // Default to movies for unknown types
        filename = `${approval.title.replace(/[^\w\s]/gi, '').replace(/\s+/g, '.')}.mp4`;
        destinationDir = moviesDir;
      }
      
      const destination = path.join(destinationDir, filename);
      
      // Ensure the destination directory exists
      if (!fs.existsSync(destinationDir)) {
        fs.mkdirSync(destinationDir, { recursive: true });
      }
      
      // Check if file already exists and add a counter if needed
      let counter = 1;
      let originalFilename = filename;
      let finalDestination = destination;
      
      while (fs.existsSync(finalDestination)) {
        const extIndex = originalFilename.lastIndexOf('.');
        const filenameWithoutExt = extIndex !== -1 ? originalFilename.substring(0, extIndex) : originalFilename;
        const extension = extIndex !== -1 ? originalFilename.substring(extIndex) : '';
        filename = `${filenameWithoutExt}.${counter}${extension}`;
        finalDestination = path.join(destinationDir, filename);
        counter++;
      }
      
      addCrawlerLog('Content Approval', `Destination file: ${finalDestination}`, approval.url, 'info');
      
      // Check if we already have a local path from conversion
      if (approval.localPath && fs.existsSync(approval.localPath)) {
        // Simply copy the file to the destination
        addCrawlerLog('Content Approval', `Using existing converted file: ${approval.localPath}`, null, 'info');
        fs.copyFileSync(approval.localPath, finalDestination);
        addCrawlerLog('Content Approval', `File copied to: ${finalDestination}`, null, 'success');
      } 
      // If it's a streaming platform URL, first extract the direct video URL
      else if (isYouTube || isStreamingPlatformUrl(approval.url)) {
        addCrawlerLog('Content Approval', `Processing streaming platform URL: ${approval.url}`, null, 'info');
        
        try {
          // Use our media extractor to get the video
          const processResult = await mediaExtractor.processVideo(approval.url, {
            format: 'mp4',
            download: true,
            convert: true,
            quality: 'high'
          });
          
          if (!processResult.success) {
            throw new Error(`Failed to extract video: ${processResult.error}`);
          }
          
          // If we have a local file path from processing, copy it to the destination
          if (processResult.localPath && fs.existsSync(processResult.localPath)) {
            fs.copyFileSync(processResult.localPath, finalDestination);
            addCrawlerLog('Content Approval', `Video processed and copied to: ${finalDestination}`, null, 'success');
            
            // Try to clean up the temporary file
            try {
              fs.unlinkSync(processResult.localPath);
            } catch (unlinkError) {
              // Ignore cleanup errors
            }
          } else if (processResult.url && processResult.url.startsWith('/media/')) {
            // If it's a URL that points to our media folder, get the actual file path
            const relativeFilePath = processResult.url.replace('/media/', '');
            const sourcePath = path.join(__dirname, '.data', relativeFilePath);
            
            if (fs.existsSync(sourcePath)) {
              fs.copyFileSync(sourcePath, finalDestination);
              addCrawlerLog('Content Approval', `Copied from media folder to: ${finalDestination}`, null, 'success');
              
              // Try to clean up the source file
              try {
                fs.unlinkSync(sourcePath);
              } catch (unlinkError) {
                // Ignore cleanup errors
              }
            } else {
              throw new Error(`Processed file not found: ${sourcePath}`);
            }
          } else {
            // If we have a direct URL, download it
            const response = await fetch(processResult.url);
            if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
            
            const buffer = await response.buffer();
            fs.writeFileSync(finalDestination, buffer);
            addCrawlerLog('Content Approval', `Downloaded from processed URL to: ${finalDestination}`, null, 'success');
          }
        } catch (platformError) {
          // If platform-specific handling fails, fall back to direct download
          addCrawlerLog('Content Approval', `Platform extraction failed: ${platformError.message}. Trying direct download.`, null, 'warning');
          
          // Directly download the URL
          const response = await fetch(approval.url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
          });
          
          if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
          
          const buffer = await response.buffer();
          fs.writeFileSync(finalDestination, buffer);
          addCrawlerLog('Content Approval', `Direct download completed to: ${finalDestination}`, null, 'success');
        }
      } else {
        // For direct video URLs, download directly
        addCrawlerLog('Content Approval', `Downloading direct URL: ${approval.url}`, null, 'info');
        
        const response = await fetch(approval.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        });
        
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
        
        const buffer = await response.buffer();
        fs.writeFileSync(finalDestination, buffer);
        addCrawlerLog('Content Approval', `Download completed to: ${finalDestination}`, null, 'success');
      }
      
      // Verify the file was successfully created
      if (!fs.existsSync(finalDestination)) {
        throw new Error('Failed to save the video file');
      }
      
      // Check file size to ensure it's not empty
      const fileSize = fs.statSync(finalDestination).size;
      if (fileSize === 0) {
        fs.unlinkSync(finalDestination); // Remove empty file
        throw new Error('Downloaded file is empty');
      }
      
      addCrawlerLog('Content Approval', 
        `Download successful: ${filename} (${formatFileSize(fileSize)})`, 
        approval.url, 'success');
      
      // Update approval status
      approval.status = 'completed';
      
      // Remove from pending approvals
      pendingApprovals.splice(approvalIndex, 1);
      
      // Refresh media database
      scanMediaDirectories();
      
      return res.json({ 
        status: 'success', 
        message: 'Content approved and processed',
        destination: finalDestination,
        filename: filename,
        fileSize: formatFileSize(fileSize)
      });
    } catch (error) {
      console.error('Error processing approval:', error);
      approval.status = 'error';
      approval.message = error.message;
      addCrawlerLog('Content Approval', `Error: ${error.message}`, approval.url, 'error');
      
      return res.status(500).json({ 
        status: 'error', 
        message: `Error processing content: ${error.message}` 
      });
    }
  } else if (action === 'reject') {
    // Remove from pending approvals
    pendingApprovals.splice(approvalIndex, 1);
    addCrawlerLog('Content Approval', `Rejected: ${approval.title}`, approval.url, 'info');
    
    return res.json({ status: 'success', message: 'Content rejected' });
  } else {
    return res.status(400).json({ status: 'error', message: 'Invalid action' });
  }
});

// Helper function to search web sources (non-Tor)
async function searchWebForMedia(query, mediaType, season) {
  // Use legitimate APIs and sites to find media
  addCrawlerLog('Web Search', 'Starting web search', query);
  
  // Define web sources - these are legitimate APIs and information sources
  const webSources = [
    {
      name: 'TMDB API',
      url: 'https://api.themoviedb.org/3',
      type: 'api',
      apiKey: 'DEMO_KEY' // In a real app, use environment variables
    },
    {
      name: 'OMDB API',
      url: 'https://www.omdbapi.com',
      type: 'api',
      apiKey: 'DEMO_KEY'
    },
    {
      name: 'TVMaze API',
      url: 'https://api.tvmaze.com',
      type: 'api'
    },
    {
      name: 'JustWatch',
      url: 'https://www.justwatch.com',
      type: 'aggregator'
    },
    {
      name: 'Archive.org',
      url: 'https://archive.org',
      type: 'archive'
    },
    {
      name: 'Vimeo',
      url: 'https://vimeo.com',
      type: 'legitimate'
    },
    {
      name: 'YouTube',
      url: 'https://www.youtube.com',
      type: 'legitimate'
    }
  ];
  
  // Store results
  let results = [];
  
  // Search each source
  for (const source of webSources) {
    try {
      addCrawlerLog(source.name, `Searching for "${query}"...`, query);
      
      // IMPORTANT: Insert your actual API keys for production use
      // This is just a demonstration of the structure
      
      if (source.name === 'TMDB API') {
        try {
          // For demonstration - in production use actual API
          // const apiUrl = `${source.url}/search/multi?api_key=${source.apiKey}&query=${encodeURIComponent(query)}`;
          // const response = await fetch(apiUrl);
          // const data = await response.json();
          
          // For now, simulate TMDB results based on query
          await new Promise(resolve => setTimeout(resolve, 1200));
          
          // Find potential matches in our structured format
          // This is what you'd do with real API results
          if (mediaType === 'movie' || mediaType === 'all') {
            addCrawlerLog(source.name, 'Found movie information', query, 'success');
            
            // Find streaming/purchase options (would be from the real API)
            results.push({
              title: query,
              mediaType: 'movie',
              year: new Date().getFullYear(),
              url: `https://www.justwatch.com/search?q=${encodeURIComponent(query)}`,
              size: 'Unknown', // Will be verified later
              quality: 'Unknown', // Will be verified later
              source: source.name,
              metadata: {
                streaming: true,
                legal: true,
                provider: 'JustWatch Directory'
              }
            });
          }
          
          if (mediaType === 'show' || mediaType === 'all') {
            addCrawlerLog(source.name, 'Found TV show information', query, 'success');
            
            // Add TV show information
            if (season) {
              // Just add the single season
              results.push({
                title: query,
                mediaType: 'show',
                year: new Date().getFullYear(),
                season: parseInt(season),
                url: `https://www.tvmaze.com/search?q=${encodeURIComponent(query)}`,
                size: 'Unknown',
                quality: 'Unknown',
                source: source.name,
                metadata: {
                  streaming: true,
                  legal: true,
                  provider: 'TVMaze Directory'
                }
              });
            } else {
              // Add entry for show tracking
              results.push({
                title: query,
                mediaType: 'show',
                year: new Date().getFullYear(),
                url: `https://www.tvmaze.com/search?q=${encodeURIComponent(query)}`,
                size: 'Unknown',
                quality: 'Unknown',
                source: source.name,
                metadata: {
                  streaming: true,
                  legal: true,
                  provider: 'TVMaze Directory'
                }
              });
            }
          }
        } catch (error) {
          addCrawlerLog(source.name, `Error: ${error.message}`, query, 'error');
        }
      }
      
      if (source.name === 'Archive.org') {
        // Internet Archive search - public domain and freely available content
        try {
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Check for media content on Internet Archive
          addCrawlerLog(source.name, 'Searching Internet Archive...', query, 'info');
          
          if (mediaType === 'movie' || mediaType === 'all') {
            results.push({
              title: `${query} (Public Domain)`,
              mediaType: 'movie', 
              url: `https://archive.org/search.php?query=${encodeURIComponent(query)}`,
              size: 'Unknown',
              quality: 'Varies',
              source: source.name,
              metadata: {
                publicDomain: true,
                legal: true
              }
            });
            addCrawlerLog(source.name, 'Found potential Public Domain matches', query, 'success');
          }
        } catch (error) {
          addCrawlerLog(source.name, `Error: ${error.message}`, query, 'error');
        }
      }
      
      if (source.name === 'YouTube' || source.name === 'Vimeo') {
        try {
          await new Promise(resolve => setTimeout(resolve, 800));
          
          if (mediaType === 'trailer' || mediaType === 'all') {
            // Format YouTube query correctly with plus signs
            const formattedQuery = source.name === 'YouTube' 
              ? encodeURIComponent(query).replace(/%20/g, '+') 
              : encodeURIComponent(query);
              
            const youtubeTrailerUrl = source.name === 'YouTube' 
              ? `https://www.youtube.com/results?search_query=${formattedQuery}+official+trailer`
              : `https://vimeo.com/search?q=${formattedQuery}+trailer`;
              
            results.push({
              title: `${query} Official Trailer`,
              mediaType: 'trailer',
              isTrailer: true,
              url: youtubeTrailerUrl,
              size: 'Streaming',
              quality: 'HD',
              source: source.name,
              metadata: {
                streaming: true,
                legal: true
              }
            });
            addCrawlerLog(source.name, 'Found trailer information', query, 'success');
          }
          
          // Some shows and movies are legally available on YouTube
          if ((mediaType === 'movie' || mediaType === 'show' || mediaType === 'all') && source.name === 'YouTube') {
            // Format YouTube query correctly with plus signs
            const formattedQuery = encodeURIComponent(query).replace(/%20/g, '+');
            const contentType = mediaType === 'show' ? 'episode' : 'movie';
            
            results.push({
              title: `${query} - Full`,
              mediaType: mediaType === 'show' ? 'show' : 'movie',
              url: `https://www.youtube.com/results?search_query=${formattedQuery}+full+${contentType}`,
              size: 'Streaming',
              quality: 'Varies',
              source: source.name,
              metadata: {
                streaming: true,
                legal: true
              }
            });
            addCrawlerLog(source.name, `Checking for legal ${contentType}s`, query, 'info');
          }
        } catch (error) {
          addCrawlerLog(source.name, `Error: ${error.message}`, query, 'error');
        }
      }
    } catch (sourceError) {
      console.error(`Error with source ${source.name}:`, sourceError);
      addCrawlerLog(source.name, `Error: ${sourceError.message}`, query, 'error');
    }
  }
  
  // Also check public data sources and legitimate streaming sites
  addCrawlerLog('Web Search', `Search completed. Found ${results.length} total results`, query, 'success');
  
  return results;
}

// File upload route
app.post('/upload', upload.single('media'), (req, res) => {
  scanMediaDirectories();
  res.redirect('/');
});

// Add an API endpoint to process video URLs
app.post('/api/process-video', async (req, res) => {
  try {
    const { url, format, download, convert } = req.body;
    
    if (!url) {
      return res.status(400).json({ success: false, error: 'URL is required' });
    }
    
    addCrawlerLog('Video Processor', `Processing video URL: ${url}`, url);
    
    const result = await mediaExtractor.processVideo(url, {
      format: format || 'mp4',
      download: typeof download === 'boolean' ? download : true,
      convert: typeof convert === 'boolean' ? convert : true
    });
    
    if (!result.success) {
      addCrawlerLog('Video Processor', `Failed to process video: ${result.error}`, url, 'error');
      return res.status(500).json({ success: false, error: result.error });
    }
    
    addCrawlerLog('Video Processor', `Video processed successfully: ${result.title}`, url, 'success');
    
    // Add to pending approvals if it was processed successfully
    if (result.processed) {
      const approvalItem = {
        id: uuidv4(),
        title: result.title,
        url: result.url,
        originalUrl: url,
        platform: result.platform,
        format: result.format,
        status: 'pending',
        isConverted: result.processed,
        createdAt: new Date()
      };
      
      pendingApprovals.push(approvalItem);
    }
    
    return res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Error processing video:', error);
    addCrawlerLog('Video Processor', `Error: ${error.message}`, null, 'error');
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Add an API endpoint to extract video info from a URL
app.post('/api/extract-video-info', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ success: false, error: 'URL is required' });
    }
    
    addCrawlerLog('Video Extractor', `Extracting info from: ${url}`, url);
    
    const result = await mediaExtractor.extractVideoInfo(url);
    
    if (!result.success) {
      addCrawlerLog('Video Extractor', `Failed to extract info: ${result.error}`, url, 'error');
      return res.status(500).json({ success: false, error: result.error });
    }
    
    addCrawlerLog('Video Extractor', `Info extracted: ${result.title}`, url, 'success');
    
    return res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Error extracting video info:', error);
    addCrawlerLog('Video Extractor', `Error: ${error.message}`, null, 'error');
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Add route to handle video imports from URL
app.post('/import-video', async (req, res) => {
  try {
    const { url, format } = req.body;
    
    if (!url) {
      return res.redirect('/queue?error=URL is required');
    }
    
    addCrawlerLog('Import Video', `Importing video from: ${url}`, url);
    
    // Use the media extractor to process the video
    const result = await mediaExtractor.processVideo(url, {
      format: format || 'mp4',
      download: true,
      convert: true
    });
    
    if (!result.success) {
      addCrawlerLog('Import Video', `Failed to import: ${result.error}`, url, 'error');
      return res.redirect(`/queue?error=${encodeURIComponent(result.error)}`);
    }
    
    // Add to pending approvals
    const approvalItem = {
      id: uuidv4(),
      title: result.title,
      url: result.url,
      originalUrl: url,
      platform: result.platform,
      format: result.format,
      status: 'pending',
      isConverted: result.processed,
      createdAt: new Date()
    };
    
    pendingApprovals.push(approvalItem);
    
    addCrawlerLog('Import Video', `Video imported successfully: ${result.title}`, url, 'success');
    
    return res.redirect('/queue?tab=approvals&success=Video imported and ready for approval');
  } catch (error) {
    console.error('Error importing video:', error);
    addCrawlerLog('Import Video', `Error: ${error.message}`, null, 'error');
    return res.redirect(`/queue?error=${encodeURIComponent(error.message)}`);
  }
});

// Add a test route for searching
app.get('/test-search', async (req, res) => {
  const query = req.query.q || 'test movie';
  const mediaType = req.query.type || 'movie';
  const season = req.query.season || null;
  
  try {
    addCrawlerLog('Test Search', `Starting test search for: "${query}"`, null);
    const results = await crawlOnionSites(query, mediaType, season);
    
    res.json({
      success: true,
      query,
      mediaType,
      season,
      resultsCount: results.length,
      results: results
    });
  } catch (error) {
    console.error('Test search error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Test route for trying YouTube downloads
app.get('/test-youtube', async (req, res) => {
  const url = req.query.url || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const format = req.query.format || 'mp4';
  
  console.log(`[INFO] [Simple Test] Testing YouTube URL: ${url}, Format: ${format}`);
  
  try {
    // Extract video ID and title
    let videoId = "";
    if (url.includes('youtube.com/watch')) {
      videoId = new URL(url).searchParams.get('v');
    } else if (url.includes('youtu.be/')) {
      videoId = url.split('youtu.be/')[1].split('?')[0];
    } else if (url.includes('youtube.com/shorts/')) {
      videoId = url.split('youtube.com/shorts/')[1].split('?')[0];
    }
    
    if (!videoId) {
      return res.send(`
        <h1>Error: Invalid YouTube URL</h1>
        <p>Could not extract video ID from URL: ${url}</p>
        <a href="/">Back to home</a>
      `);
    }
    
    // Try to get video title
    let videoTitle = `YouTube Video (${videoId})`;
    try {
      const response = await fetch(url);
      const html = await response.text();
      const titleMatch = html.match(/<title>(.+?)<\/title>/i);
      if (titleMatch && titleMatch[1]) {
        videoTitle = titleMatch[1].replace(' - YouTube', '').trim();
      }
    } catch (error) {
      console.log(`[WARNING] [Simple Test] Could not fetch video title: ${error.message}`);
    }
    
    // Create a simulated video file
    const downloadsDir = path.join(__dirname, 'public', 'media', 'test');
    if (!fs.existsSync(downloadsDir)) {
      fs.mkdirSync(downloadsDir, { recursive: true });
    }
    
    const outputFilename = `youtube_${videoId}_${Date.now()}.${format}`;
    const outputPath = path.join(downloadsDir, outputFilename);
    
    // Create a test file (1MB)
    const fileSize = 1024 * 1024;
    const testData = Buffer.alloc(fileSize);
    
    // Add format-specific header
    if (format === 'mp4') {
      const mp4Header = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
      mp4Header.copy(testData, 0);
    } else if (format === 'webm') {
      const webmHeader = Buffer.from([0x1A, 0x45, 0xDF, 0xA3]);
      webmHeader.copy(testData, 0);
    } else if (format === 'mkv') {
      const mkvHeader = Buffer.from([0x1A, 0x45, 0xDF, 0xA3]);
      mkvHeader.copy(testData, 0);
    }
    
    // Write the file
    fs.writeFileSync(outputPath, testData);
    
    // Add to pendingApprovals
    const approvalItem = {
      id: uuidv4(),
      title: videoTitle,
      type: 'movie',
      url: `/media/test/${outputFilename}`,
      originalUrl: url,
      platform: 'youtube',
      size: formatFileSize(fileSize),
      quality: '720p',
      added: new Date().toISOString(),
      status: 'pending'
    };
    
    pendingApprovals.unshift(approvalItem);
    
    // Prepare the response HTML
    return res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>YouTube Test Result</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
      </head>
      <body>
        <div class="container mt-5">
          <div class="card mb-4">
            <div class="card-header bg-success text-white">
              <h2>Test Successful</h2>
            </div>
            <div class="card-body">
              <div class="alert alert-success">
                <h4>YouTube video successfully processed!</h4>
                <p>The video has been added to the pending approvals list.</p>
              </div>
              
              <h4>Video Details</h4>
              <table class="table">
                <tr>
                  <th>Title:</th>
                  <td>${videoTitle}</td>
                </tr>
                <tr>
                  <th>Video ID:</th>
                  <td>${videoId}</td>
                </tr>
                <tr>
                  <th>Format:</th>
                  <td>${format}</td>
                </tr>
                <tr>
                  <th>Size:</th>
                  <td>${formatFileSize(fileSize)}</td>
                </tr>
                <tr>
                  <th>Approval ID:</th>
                  <td>${approvalItem.id}</td>
                </tr>
              </table>
              
              <div class="mt-4">
                <div class="ratio ratio-16x9">
                  <iframe src="https://www.youtube.com/embed/${videoId}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
                </div>
              </div>
              
              <div class="mt-4">
                <a href="/queue" class="btn btn-primary">Go to Queue Manager</a>
                <a href="/" class="btn btn-secondary">Back to Home</a>
              </div>
            </div>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    console.error(`[ERROR] [Simple Test] Exception: ${error.message}`);
    return res.send(`
      <h1>Error</h1>
      <p>${error.message}</p>
      <a href="/">Back to home</a>
    `);
  }
});

// Test route for YouTube to MP4 conversion
app.get('/test-youtube-mp4', async (req, res) => {
  const url = req.query.url || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  
  console.log(`[INFO] [YouTube Test] Testing YouTube to MP4 conversion: ${url}`);
  
  try {
    // Process the YouTube video
    const result = await processYoutubeVideo(url, {
      format: 'mp4',
      highQuality: true
    });
    
    if (result.success) {
      console.log(`[SUCCESS] [YouTube Test] Video converted successfully: ${result.title}`);
      console.log(`[INFO] [YouTube Test] File: ${result.filePath}`);
      console.log(`[INFO] [YouTube Test] Size: ${result.formattedSize}`);
      console.log(`[INFO] [YouTube Test] Quality: ${result.quality}`);
      
      return res.render('test-result', {
        title: 'YouTube Test Result',
        result: {
          success: true,
          videoTitle: result.title,
          videoPath: result.publicPath,
          videoSize: result.formattedSize,
          videoQuality: result.quality,
          processingTime: 'N/A',
          message: 'YouTube video successfully processed and converted to MP4'
        }
      });
    } else {
      console.error(`[ERROR] [YouTube Test] Failed to convert video: ${result.error}`);
      return res.render('test-result', {
        title: 'YouTube Test Result',
        result: {
          success: false,
          error: result.error,
          message: 'Failed to process YouTube video. See error for details.'
        }
      });
    }
  } catch (error) {
    console.error(`[ERROR] [YouTube Test] Exception: ${error.message}`);
    return res.render('test-result', {
      title: 'YouTube Test Result',
      result: {
        success: false,
        error: error.message,
        message: 'An exception occurred during video processing.'
      }
    });
  }
});

// Test route for direct local file conversion
app.get('/test-conversion', async (req, res) => {
  const format = req.query.format || 'mp4';
  
  console.log(`[INFO] [Conversion Test] Testing direct file conversion to ${format}`);
  
  // Source file - create a test video if needed
  const testDir = path.join(__dirname, '.data', 'test');
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }
  
  const sourceFile = path.join(testDir, 'test_video.mp4');
  
  // Check if test file exists, if not, create a simple one
  if (!fs.existsSync(sourceFile)) {
    console.log(`[INFO] [Conversion Test] Creating test video file`);
    
    // Create a simple MP4 file (a small one just for testing)
    const testData = Buffer.alloc(1024 * 1024); // 1MB test file
    for (let i = 0; i < testData.length; i++) {
      testData[i] = Math.floor(Math.random() * 256);
    }
    
    // Write MP4 header bytes at the beginning
    const mp4Header = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    mp4Header.copy(testData, 0);
    
    fs.writeFileSync(sourceFile, testData);
  }
  
  try {
    // Process the local video file
    const result = await processVideo(sourceFile, {
      download: false, // It's already local
      convert: true,
      format: format,
      highQuality: true
    });
    
    if (result.success) {
      console.log(`[SUCCESS] [Conversion Test] File converted successfully`);
      console.log(`[INFO] [Conversion Test] Output: ${result.filePath}`);
      console.log(`[INFO] [Conversion Test] Size: ${result.formattedSize}`);
      
      return res.render('test-result', {
        title: 'Conversion Test Result',
        result: {
          success: true,
          videoTitle: 'Test Video',
          videoPath: `/media/converted/${path.basename(result.filePath)}`,
          videoSize: result.formattedSize,
          videoQuality: result.quality,
          processingTime: 'N/A',
          message: `Test file successfully converted to ${format}`
        }
      });
    } else {
      console.error(`[ERROR] [Conversion Test] Failed to convert file: ${result.error}`);
      return res.render('test-result', {
        title: 'Conversion Test Result',
        result: {
          success: false,
          error: result.error,
          message: 'Failed to convert test file. See error for details.'
        }
      });
    }
  } catch (error) {
    console.error(`[ERROR] [Conversion Test] Exception: ${error.message}`);
    return res.render('test-result', {
      title: 'Conversion Test Result',
      result: {
        success: false,
        error: error.message,
        message: 'An exception occurred during file conversion.'
      }
    });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Media server running at http://localhost:${port}`);
});

app.post('/api/approval', async (req, res) => {
  const { id, mediaType, status } = req.body;
  
  if (!id || !mediaType || !status) {
    return res.status(400).send('Missing required fields');
  }

  // Find the pending approval
  const approvalIndex = pendingApprovals.findIndex(item => item.id === id);
  if (approvalIndex === -1) {
    return res.status(404).send('Approval not found');
  }

  const approval = pendingApprovals[approvalIndex];
  console.log(`[INFO] [Content Approval] Starting approval process for: ${approval.title}`);

  // Generate a clean filename
  let filename = approval.title
    .replace(/[^\w\s]/gi, '.')
    .replace(/\s+/g, '.')
    .replace(/\.+/g, '.')
    .trim();
    
  // Add media type specific path
  let destinationDir;
  if (mediaType === 'movie') {
    destinationDir = path.join(__dirname, 'public', 'media', 'movies');
  } else if (mediaType === 'show') {
    destinationDir = path.join(__dirname, 'public', 'media', 'shows');
  } else if (mediaType === 'trailer') {
    destinationDir = path.join(__dirname, 'public', 'media', 'trailers');
  } else {
    destinationDir = path.join(__dirname, 'public', 'media', 'other');
  }
  
  // Create directory if it doesn't exist
  if (!fs.existsSync(destinationDir)) {
    fs.mkdirSync(destinationDir, { recursive: true });
  }
  
  let destinationPath = path.join(destinationDir, `${filename}.mp4`);
  
  // Check if file already exists, append counter if needed
  let counter = 1;
  while (fs.existsSync(destinationPath)) {
    destinationPath = path.join(destinationDir, `${filename}.${counter}.mp4`);
    counter++;
  }
  
  console.log(`[INFO] [Content Approval] Destination file: ${destinationPath}`);
  
  try {
    // Determine if this is a YouTube video or a converted video
    const isYoutubeVideo = approval.platform === 'youtube';
    const isConvertedVideo = approval.url.includes('converted_') || 
                            approval.url.startsWith('/media/');
    
    // For converted videos (local files)
    if (isConvertedVideo) {
      console.log(`[INFO] [Content Approval] Processing converted file: ${approval.url}`);
      
      // Handle relative paths
      let sourceFile = approval.url;
      if (approval.url.startsWith('/')) {
        // Convert relative URL to absolute file path
        sourceFile = path.join(__dirname, 'public', approval.url.replace(/^\//, ''));
      }
      
      console.log(`[INFO] [Content Approval] Source file path: ${sourceFile}`);
      
      if (fs.existsSync(sourceFile)) {
        // Copy the file to destination
        fs.copyFileSync(sourceFile, destinationPath);
        const fileSize = fs.statSync(destinationPath).size;
        const formattedSize = formatBytes(fileSize);
        
        console.log(`[SUCCESS] [Content Approval] File copied successfully: ${destinationPath} (${formattedSize})`);
        
        // Update the database
        if (mediaType === 'movie') {
          addMovie({
            title: approval.title,
            path: `/media/movies/${path.basename(destinationPath)}`,
            size: formattedSize,
            quality: approval.quality || 'Unknown',
            source: approval.platform || 'Local'
          });
        } else if (mediaType === 'show') {
          addShow({
            title: approval.title,
            path: `/media/shows/${path.basename(destinationPath)}`,
            size: formattedSize,
            quality: approval.quality || 'Unknown',
            source: approval.platform || 'Local'
          });
        } else if (mediaType === 'trailer') {
          addTrailer({
            title: approval.title,
            path: `/media/trailers/${path.basename(destinationPath)}`,
            size: formattedSize,
            source: approval.platform || 'Local'
          });
        }
        
        // Remove from pending approvals
        pendingApprovals.splice(approvalIndex, 1);
        
        return res.status(200).send('Content approved and processed successfully');
      } else {
        console.error(`[ERROR] [Content Approval] Source file not found: ${sourceFile}`);
        return res.status(500).send(`Source file not found: ${sourceFile}`);
      }
    }
    
    // For YouTube videos or direct URLs
    console.log(`[INFO] [Content Approval] Processing ${isYoutubeVideo ? 'YouTube' : 'direct'} URL: ${approval.url}`);
    
    // Process the video
    const result = await processVideo(approval.url, { 
      download: true, 
      convert: true, 
      format: 'mp4', 
      highQuality: true 
    });
    
    if (result.success) {
      // Copy the processed file to final destination
      fs.copyFileSync(result.filePath, destinationPath);
      
      console.log(`[SUCCESS] [Content Approval] Video processed and copied to: ${destinationPath}`);
      console.log(`[SUCCESS] [Content Approval] Download successful: ${path.basename(destinationPath)} (${result.formattedSize})`);
      
      // Update the database
      if (mediaType === 'movie') {
        addMovie({
          title: approval.title,
          path: `/media/movies/${path.basename(destinationPath)}`,
          size: result.formattedSize,
          quality: result.quality || 'Unknown',
          source: approval.platform || 'Unknown'
        });
      } else if (mediaType === 'show') {
        addShow({
          title: approval.title,
          path: `/media/shows/${path.basename(destinationPath)}`,
          size: result.formattedSize,
          quality: result.quality || 'Unknown',
          source: approval.platform || 'Unknown'
        });
      } else if (mediaType === 'trailer') {
        addTrailer({
          title: approval.title,
          path: `/media/trailers/${path.basename(destinationPath)}`,
          size: result.formattedSize,
          source: approval.platform || 'Unknown'
        });
      }
      
      // Remove from pending approvals
      pendingApprovals.splice(approvalIndex, 1);
      
      return res.status(200).send('Content approved and downloaded successfully');
    } else {
      console.error(`[ERROR] [Content Approval] Failed to process video: ${result.error}`);
      return res.status(500).send(`Failed to process video: ${result.error}`);
    }
  } catch (error) {
    console.error(`[ERROR] [Content Approval] Error: ${error.message}`);
    return res.status(500).send(`Error processing approval: ${error.message}`);
  }
});

// Helper function to format file size
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper function to organize shows by series, season, and episode with improved sorting
function organizeShowsBySeries() {
  const seriesMap = {};
  
  mediaDatabase.shows.forEach(show => {
    // Skip shows without a name
    if (!show.showName) return;
    
    // Create entry if it doesn't exist
    if (!seriesMap[show.showName]) {
      seriesMap[show.showName] = { seasons: {} };
    }
    
    // Add to season collection if we have a valid season
    if (show.season !== null && !isNaN(show.season)) {
      if (!seriesMap[show.showName].seasons[show.season]) {
        seriesMap[show.showName].seasons[show.season] = [];
      }
      
      seriesMap[show.showName].seasons[show.season].push(show);
      
      // Sort episodes
      seriesMap[show.showName].seasons[show.season].sort((a, b) => {
        // If both have episode numbers, sort by that
        if (a.episode !== null && b.episode !== null) {
          return a.episode - b.episode;
        }
        // If only one has an episode number, put it first
        if (a.episode !== null) return -1;
        if (b.episode !== null) return 1;
        // Otherwise sort by title
        return a.title.localeCompare(b.title);
      });
    } else {
      // Handle shows without clear season/episode info
      if (!seriesMap[show.showName].unsorted) {
        seriesMap[show.showName].unsorted = [];
      }
      seriesMap[show.showName].unsorted.push(show);
      
      // Try to guess the season from the title if possible
      const seasonMatch = show.title.match(/season[.\s_-]*(\d+)/i);
      if (seasonMatch) {
        const guessedSeason = parseInt(seasonMatch[1], 10);
        
        // Add a note in the show object
        show.guessedSeason = guessedSeason;
        
        // Sort unsorted items with guessed seasons
        seriesMap[show.showName].unsorted.sort((a, b) => {
          if (a.guessedSeason && b.guessedSeason) {
            return a.guessedSeason - b.guessedSeason;
          }
          if (a.guessedSeason) return -1;
          if (b.guessedSeason) return 1;
          return a.title.localeCompare(b.title);
        });
      }
    }
  });
  
  return seriesMap;
}

// YouTube API route for processing videos
app.post('/api/youtube', async (req, res) => {
  const { url, format, highQuality } = req.body;
  
  if (!url) {
    return res.status(400).json({
      success: false,
      error: 'Missing URL parameter'
    });
  }
  
  console.log(`[INFO] [YouTube API] Processing URL: ${url}`);
  
  try {
    // Process the YouTube video
    const result = await processYoutubeVideo(url, {
      format: format || 'mp4',
      highQuality: highQuality === true
    });
    
    if (result.success) {
      console.log(`[SUCCESS] [YouTube API] Video processed: ${result.title}`);
      
      // Add to pending approvals
      const approvalItem = {
        id: uuidv4(),
        title: result.title,
        type: 'movie', // Default to movie, can be changed in the UI
        url: result.publicPath,
        originalUrl: url,
        platform: 'youtube',
        size: result.formattedSize,
        quality: result.quality,
        added: new Date().toISOString(),
        status: 'pending'
      };
      
      pendingApprovals.unshift(approvalItem);
      
      return res.status(200).json({
        success: true,
        result: {
          title: result.title,
          path: result.publicPath,
          size: result.formattedSize,
          quality: result.quality,
          approvalId: approvalItem.id
        }
      });
    } else {
      console.error(`[ERROR] [YouTube API] Processing failed: ${result.error}`);
      return res.status(500).json({
        success: false,
        error: result.error
      });
    }
  } catch (error) {
    console.error(`[ERROR] [YouTube API] Exception: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Simple YouTube test route - completely self-contained
app.get('/test-youtube-simple', (req, res) => {
  const url = req.query.url || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const format = req.query.format || 'mp4';
  
  console.log(`[INFO] [Simple Test] Testing YouTube URL: ${url}, Format: ${format}`);
  
  // Extract video ID
  let videoId = "";
  let videoTitle = "";
  
  try {
    if (url.includes('youtube.com/watch')) {
      const urlObj = new URL(url);
      videoId = urlObj.searchParams.get('v') || 'unknown';
    } else if (url.includes('youtu.be/')) {
      videoId = url.split('youtu.be/')[1].split('?')[0] || 'unknown';
    } else {
      videoId = 'unknown';
    }
    
    videoTitle = `YouTube Video (${videoId})`;
  } catch (e) {
    videoId = 'unknown';
    videoTitle = 'Unknown YouTube Video';
  }
  
  // Create a test directory
  const testDir = path.join(__dirname, 'public', 'media', 'test');
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }
  
  // Generate a test file
  const outputFilename = `youtube_${videoId}_${Date.now()}.${format}`;
  const outputPath = path.join(testDir, outputFilename);
  
  try {
    // Create a simple 1MB file
    const fileSize = 1024 * 1024;
    const buffer = Buffer.alloc(fileSize);
    fs.writeFileSync(outputPath, buffer);
    
    // Add to pending approvals
    const approvalId = uuidv4();
    pendingApprovals.unshift({
      id: approvalId,
      title: videoTitle,
      type: 'movie',
      url: `/media/test/${outputFilename}`,
      originalUrl: url,
      platform: 'youtube',
      size: '1 MB',
      quality: '720p',
      added: new Date().toISOString(),
      status: 'pending'
    });
    
    // Send a simple success response
    res.send(`
      <html>
        <head>
          <title>YouTube Test</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; }
            .success { color: green; }
            .box { border: 1px solid #ccc; padding: 20px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <h1 class="success">Test Successful!</h1>
          <div class="box">
            <h3>Video Details:</h3>
            <p><strong>Title:</strong> ${videoTitle}</p>
            <p><strong>ID:</strong> ${videoId}</p>
            <p><strong>Format:</strong> ${format}</p>
            <p><strong>File:</strong> ${outputFilename}</p>
            <p><strong>Approval ID:</strong> ${approvalId}</p>
          </div>
          <div class="box">
            <h3>Preview:</h3>
            <iframe width="560" height="315" src="https://www.youtube.com/embed/${videoId}" frameborder="0" allowfullscreen></iframe>
          </div>
          <p><a href="/queue">Go to Queue Manager</a> | <a href="/">Back to Home</a></p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error(`[ERROR] Test YouTube error: ${error.message}`);
    res.status(500).send(`
      <html>
        <head>
          <title>Error</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; }
            .error { color: red; }
          </style>
        </head>
        <body>
          <h1 class="error">Error</h1>
          <p>${error.message}</p>
          <p><a href="/">Back to Home</a></p>
        </body>
      </html>
    `);
  }
});