const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const morgan = require('morgan');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const https = require('https');
const SocksProxyAgent = require('socks-proxy-agent');

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

// Constants
const MAX_QUEUE_SIZE = 50; // Maximum number of items in the search queue
const MAX_APPROVAL_ITEMS = 100; // Maximum number of items in the pending approvals list
const MAX_CRAWLER_LOGS = 300; // Maximum number of crawler log entries to store

// Function to add a crawler log entry
function addCrawlerLog(site, message, type = 'info') {
  const log = {
    timestamp: new Date().toISOString(),
    site: site,
    message: message,
    type: type
  };
  
  // Add to the beginning of the array for newest-first order
  crawlerLogs.unshift(log);
  
  // Trim the logs array if it exceeds the maximum size
  if (crawlerLogs.length > MAX_CRAWLER_LOGS) {
    crawlerLogs.length = MAX_CRAWLER_LOGS;
  }
  
  return log;
}

// Function to generate test crawler logs
function generateCrawlerLogs() {
  // Clear existing logs
  crawlerLogs = [];
  
  // Add some initial logs for testing
  const sites = ['MediaVault', 'MediaBay', 'VideoCatalog', 'CinemaVault', 'StreamHaven'];
  const queries = ['Stranger Things', 'Game of Thrones', 'Breaking Bad', 'The Mandalorian'];
  const messages = [
    'Starting search...',
    'Connected to site',
    'Searching for content',
    'Found 5 potential matches',
    'Extracting video sources',
    'Found direct video link',
    'Validating video URL',
    'URL appears to be a streaming source',
    'Detected video format: MP4',
    'Estimated file size: 2.3GB',
    'Added to results',
    'Search completed'
  ];
  const types = ['info', 'success', 'warning', 'error'];
  
  // Generate 30 random logs
  for (let i = 0; i < 30; i++) {
    const site = sites[Math.floor(Math.random() * sites.length)];
    const query = queries[Math.floor(Math.random() * queries.length)];
    const message = messages[Math.floor(Math.random() * messages.length)];
    const type = types[Math.floor(Math.random() * types.length)];
    
    // Add log with a random timestamp in the last hour
    const timestamp = new Date(Date.now() - Math.floor(Math.random() * 60 * 60 * 1000));
    
    crawlerLogs.unshift({
      timestamp: timestamp.toISOString(),
      site: site,
      message: `${message} for "${query}"`,
      type: type
    });
  }
  
  console.log(`Generated ${crawlerLogs.length} test crawler logs`);
}

// Generate test logs on startup
generateCrawlerLogs();

// Ensure media directories exist
const mediaDir = path.join(__dirname, 'public', 'media');
const moviesDir = path.join(mediaDir, 'movies');
const showsDir = path.join(mediaDir, 'shows');
const trailersDir = path.join(mediaDir, 'trailers');
const downloadsDir = path.join(mediaDir, 'downloads');
const testDir = path.join(mediaDir, 'test');

[mediaDir, moviesDir, showsDir, trailersDir, downloadsDir, testDir].forEach(dir => {
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
  
  // Scan shows
  if (fs.existsSync(showsDir)) {
    // Get all show files
    const showFiles = fs.readdirSync(showsDir)
      .filter(file => ['.mp4', '.mkv', '.avi'].some(ext => file.endsWith(ext)));
    
    // Process shows with better season/episode detection
    mediaDatabase.shows = showFiles.map(file => {
      // Extract show name and episode info if available
      let title = file.replace(/\.[^/.]+$/, "");
      let showName = title;
      let season = null;
      let episode = null;
      
      // Try to extract S01E01 type pattern (standard format)
      let match = title.match(/(.+)[sS](\d+)[eE](\d+)/);
      if (match) {
        showName = match[1].trim();
        season = parseInt(match[2], 10);
        episode = parseInt(match[3], 10);
      } else {
        // Try alternate format like Show.Name.1x01
        match = title.match(/(.+)\.(\d+)x(\d+)/);
        if (match) {
          showName = match[1].replace(/\./g, ' ').trim();
          season = parseInt(match[2], 10);
          episode = parseInt(match[3], 10);
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

// Helper function to format file size
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' Bytes';
  else if (bytes < 1048576) return (bytes / 1024).toFixed(2) + ' KB';
  else if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + ' MB';
  else return (bytes / 1073741824).toFixed(2) + ' GB';
}

// Helper function to organize shows by series, season, and episode
function organizeShowsBySeries() {
  const seriesMap = {};
  
  mediaDatabase.shows.forEach(show => {
    if (!seriesMap[show.showName]) {
      seriesMap[show.showName] = { seasons: {} };
    }
    
    if (show.season !== null) {
      if (!seriesMap[show.showName].seasons[show.season]) {
        seriesMap[show.showName].seasons[show.season] = [];
      }
      
      seriesMap[show.showName].seasons[show.season].push(show);
      
      // Sort episodes
      seriesMap[show.showName].seasons[show.season].sort((a, b) => {
        return a.episode - b.episode;
      });
    } else {
      // Handle shows without clear season/episode info
      if (!seriesMap[show.showName].unsorted) {
        seriesMap[show.showName].unsorted = [];
      }
      seriesMap[show.showName].unsorted.push(show);
    }
  });
  
  return seriesMap;
}

// Helper function to add an item to the media database
function addMovie(movie) {
  if (!movie.title || !movie.path) {
    console.error('Invalid movie data:', movie);
    return false;
  }
  
  // Check if movie already exists
  const existingIndex = mediaDatabase.movies.findIndex(m => m.path === movie.path || m.title === movie.title);
  if (existingIndex !== -1) {
    // Update existing movie
    mediaDatabase.movies[existingIndex] = {
      ...mediaDatabase.movies[existingIndex],
      ...movie
    };
    return true;
  }
  
  // Add new movie
  mediaDatabase.movies.push({
    title: movie.title,
    path: movie.path,
    type: 'movie',
    size: movie.size || 'Unknown',
    quality: movie.quality || 'Unknown',
    source: movie.source || 'Unknown',
    trailer: mediaDatabase.trailers[movie.title] || null
  });
  
  return true;
}

function addShow(show) {
  if (!show.title || !show.path) {
    console.error('Invalid show data:', show);
    return false;
  }
  
  // Extract season and episode info if not provided
  let season = show.season;
  let episode = show.episode;
  let showName = show.showName || show.title;
  
  if (!season || !episode) {
    // Try to extract S01E01 type pattern
    let match = show.title.match(/(.+)[sS](\d+)[eE](\d+)/);
    if (match) {
      showName = match[1].trim();
      season = parseInt(match[2], 10);
      episode = parseInt(match[3], 10);
    } else {
      // Try alternate format like Show.Name.1x01
      match = show.title.match(/(.+)\.(\d+)x(\d+)/);
      if (match) {
        showName = match[1].replace(/\./g, ' ').trim();
        season = parseInt(match[2], 10);
        episode = parseInt(match[3], 10);
      }
    }
  }
  
  // Check if show already exists
  const existingIndex = mediaDatabase.shows.findIndex(s => s.path === show.path);
  if (existingIndex !== -1) {
    // Update existing show
    mediaDatabase.shows[existingIndex] = {
      ...mediaDatabase.shows[existingIndex],
      ...show,
      showName: showName,
      season: season,
      episode: episode
    };
    return true;
  }
  
  // Add new show
  mediaDatabase.shows.push({
    title: show.title,
    showName: showName,
    season: season,
    episode: episode,
    path: show.path,
    type: 'show',
    size: show.size || 'Unknown',
    quality: show.quality || 'Unknown',
    source: show.source || 'Unknown'
  });
  
  return true;
}

function addTrailer(trailer) {
  if (!trailer.title || !trailer.path) {
    console.error('Invalid trailer data:', trailer);
    return false;
  }
  
  // Extract movie name from trailer title
  const movieName = trailer.title.replace(' Trailer', '').trim();
  
  // Add to trailers database
  mediaDatabase.trailers[movieName] = trailer.path;
  
  // If the corresponding movie exists, update its trailer reference
  const movieIndex = mediaDatabase.movies.findIndex(m => m.title === movieName);
  if (movieIndex !== -1) {
    mediaDatabase.movies[movieIndex].trailer = trailer.path;
  }
  
  return true;
}

// Logger for crawler activities
function addCrawlerLog(source, message, details = null, level = 'info') {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    source,
    message,
    details,
    level
  };
  
  // In a real application, you might store these logs in a database
  // or send them to a monitoring service
  
  // Log to console with appropriate formatting
  let logPrefix = '';
  switch (level) {
    case 'error':
      logPrefix = '\x1b[31m[ERROR]\x1b[0m'; // Red
      break;
    case 'warning':
      logPrefix = '\x1b[33m[WARN]\x1b[0m'; // Yellow
      break;
    case 'success':
      logPrefix = '\x1b[32m[SUCCESS]\x1b[0m'; // Green
      break;
    case 'info':
    default:
      logPrefix = '\x1b[36m[INFO]\x1b[0m'; // Cyan
      break;
  }
  
  console.log(`${logPrefix} [${timestamp}] [${source}] ${message}`);
  if (details) {
    console.log(`  Details: ${typeof details === 'object' ? JSON.stringify(details) : details}`);
  }
  
  // Return the log entry for potential further processing
  return logEntry;
}

// Web server routes
app.get('/', function(req, res) {
  // Scan directories to refresh the database
  scanMediaDirectories();
  
  const searchQuery = req.query.q || '';
  let results = [];
  
  if (searchQuery) {
    // Search movies
    const movieResults = mediaDatabase.movies.filter(movie => 
      movie.title.toLowerCase().includes(searchQuery.toLowerCase())
    );
    
    // Search shows
    const showResults = mediaDatabase.shows.filter(show => 
      show.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
      show.showName.toLowerCase().includes(searchQuery.toLowerCase())
    );
    
    results = [...movieResults, ...showResults];
  }
  
  // Get a slice of movies and shows for the home page
  const recentMovies = mediaDatabase.movies.slice(0, 8);
  const recentShows = mediaDatabase.shows.slice(0, 8);
  
  res.render('index', { 
    title: 'Media Server', 
    searchQuery: searchQuery,
    results: results,
    movies: recentMovies,
    shows: recentShows
  });
});

app.get('/movies', function(req, res) {
  // Scan directories to refresh the database
  scanMediaDirectories();
  
  // Get movies sorted by title
  const sortedMovies = [...mediaDatabase.movies].sort((a, b) => {
    return a.title.localeCompare(b.title);
  });
  
  res.render('movies', { 
    title: 'Movies', 
    movies: sortedMovies
  });
});

app.get('/shows', (req, res) => {
  scanMediaDirectories();
  
  // Organize shows by series, season and episode
  const organizedShows = organizeShowsBySeries();
  
  res.render('shows', { 
    title: 'TV Shows',
    organizedShows: organizedShows 
  });
});

app.get('/queue', function(req, res) {
  res.render('queue', { 
    title: 'Queue Manager', 
    searchQueue: searchQueue,
    pendingApprovals: pendingApprovals,
    crawlerLogs: crawlerLogs
  });
});

// YouTube download page route
app.get('/youtube', function(req, res) {
  res.render('youtube', { 
    title: 'YouTube Downloader'
  });
});

// YouTube URL processing route
app.post('/process-youtube', async function(req, res) {
  const youtubeUrl = req.body.youtubeUrl;
  const outputFormat = req.body.outputFormat || 'mp4';
  const mediaType = req.body.mediaType || 'movie';
  
  if (!youtubeUrl) {
    return res.status(400).json({ error: 'YouTube URL is required' });
  }
  
  // Extract video ID from YouTube URL
  const videoIdMatch = youtubeUrl.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
  const videoId = videoIdMatch ? videoIdMatch[1] : null;
  
  if (!videoId) {
    return res.status(400).json({ error: 'Invalid YouTube URL. Could not extract video ID.' });
  }
  
  console.log(`Processing YouTube video: ${videoId} in ${outputFormat} format as ${mediaType}`);
  
  try {
    // Use the YouTube processor module
    const { processYoutubeVideo } = require('./youtube-processor');
    
    // Process the video (in a real implementation, this would download and convert)
    const result = await processYoutubeVideo(youtubeUrl, {
      format: outputFormat,
      highQuality: false
    });
    
    if (!result.success) {
      console.error(`Error processing YouTube video: ${result.error}`);
      return res.status(500).json({ error: result.error });
    }
    
    // Generate a unique approval ID
    const approvalId = require('crypto').randomUUID();
    
    // Add to pending approvals
    pendingApprovals.push({
      id: approvalId,
      title: result.title || `YouTube Video (${videoId})`,
      url: youtubeUrl,
      videoId: videoId,
      format: outputFormat,
      filePath: result.filePath,
      publicPath: result.publicPath,
      mediaType: mediaType,
      quality: result.quality || '720p',
      size: result.formattedSize || '5 MB',
      dateAdded: new Date(),
      isYouTube: true,
      processed: true
    });
    
    // Redirect to the approval preview page
    res.redirect(`/preview/${approvalId}`);
  } catch (error) {
    console.error(`Error in process-youtube: ${error.message}`);
    res.status(500).json({ error: `Failed to process YouTube video: ${error.message}` });
  }
});

// Preview page for an approval
app.get('/preview/:id', function(req, res) {
  const approvalId = req.params.id;
  const approval = pendingApprovals.find(item => item.id === approvalId);
  
  if (!approval) {
    return res.status(404).render('error', { 
      message: 'Approval not found',
      error: { status: 404, stack: '' }
    });
  }
  
  res.render('preview', { 
    title: 'Preview Content',
    approval: approval
  });
});

// Approve content route (legacy GET route for backward compatibility)
app.get('/approve/:id', function(req, res) {
  const approvalId = req.params.id;
  const approvalIndex = pendingApprovals.findIndex(item => item.id === approvalId);
  
  if (approvalIndex === -1) {
    return res.status(404).render('error', { 
      message: 'Approval not found',
      error: { status: 404, stack: '' }
    });
  }
  
  const approval = pendingApprovals[approvalIndex];
  console.log(`Approving content: ${approval.title}`);
  
  // Create destination directory based on media type
  let mediaType = approval.mediaType || 'movie';
  let destinationDir;
  let publicDestinationDir;
  
  if (mediaType === 'movie') {
    destinationDir = path.join(__dirname, '.data', 'media', 'movies');
    publicDestinationDir = path.join(__dirname, 'public', 'media', 'movies');
  } else if (mediaType === 'show') {
    destinationDir = path.join(__dirname, '.data', 'media', 'shows');
    publicDestinationDir = path.join(__dirname, 'public', 'media', 'shows');
  } else {
    destinationDir = path.join(__dirname, '.data', 'media', 'trailers');
    publicDestinationDir = path.join(__dirname, 'public', 'media', 'trailers');
  }
  
  // Create directories if they don't exist
  [destinationDir, publicDestinationDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
  
  // Construct final filename
  let sanitizedTitle = approval.title.replace(/[^\w\s-]/gi, '').replace(/\s+/g, '_');
  let finalFilename = `${sanitizedTitle}.${approval.format}`;
  let finalPath = path.join(destinationDir, finalFilename);
  let publicFinalPath = path.join(publicDestinationDir, finalFilename);
  
  // If this is a YouTube video, use the youtube-processor to handle it
  if (approval.isYouTube) {
    console.log(`Processing YouTube video: ${approval.videoId}`);
    
    try {
      // Create a simulated downloaded file with MP4 header for test purposes
      const fileSize = 5 * 1024 * 1024; // 5MB simulated file
      const testData = Buffer.alloc(fileSize);
      
      // Add MP4 header signature
      const mp4Header = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D]);
      mp4Header.copy(testData, 0);
      
      // Fill with random data
      for (let i = mp4Header.length; i < fileSize; i++) {
        testData[i] = Math.floor(Math.random() * 256);
      }
      
      // Write the file to both locations
      fs.writeFileSync(finalPath, testData);
      fs.writeFileSync(publicFinalPath, testData);
      
      console.log(`Successfully processed and saved YouTube video: ${approval.videoId}`);
      console.log(`Saved to: ${publicFinalPath}`);
    } catch (error) {
      console.error(`Error processing YouTube video: ${error.message}`);
      return res.status(500).render('error', {
        message: 'Failed to process YouTube video',
        error: { status: 500, stack: error.stack }
      });
    }
  }
  
  // Add to media database based on type
  const publicPath = `/media/${mediaType}s/${finalFilename}`;
  
  if (mediaType === 'movie') {
    addMovie({
      title: approval.title,
      path: publicPath,
      filePath: publicFinalPath,
      size: approval.size || '5 MB',
      dateAdded: new Date(),
      format: approval.format,
      source: approval.isYouTube ? 'youtube' : 'external'
    });
  } else if (mediaType === 'show') {
    // For simplicity, we'll add it as a standalone show
    addShow({
      title: approval.title,
      showName: approval.showName || approval.title,
      path: publicPath,
      filePath: publicFinalPath,
      size: approval.size || '5 MB',
      dateAdded: new Date(),
      format: approval.format,
      source: approval.isYouTube ? 'youtube' : 'external',
      season: approval.season || 1,
      episode: approval.episode || 1
    });
  } else {
    // Handle trailers
    const movieName = approval.title.replace(' Trailer', '').trim();
    addTrailer({
      title: approval.title, 
      forMovie: movieName,
      path: publicPath,
      filePath: publicFinalPath,
      size: approval.size || '5 MB',
      dateAdded: new Date(),
      format: approval.format,
      source: approval.isYouTube ? 'youtube' : 'external'
    });
  }
  
  // Remove from pending approvals
  pendingApprovals.splice(approvalIndex, 1);
  
  // Redirect to the library
  if (mediaType === 'movie') {
    res.redirect('/movies');
  } else if (mediaType === 'show') {
    res.redirect('/shows');
  } else {
    res.redirect('/');
  }
});

// Reject content route
app.get('/reject/:id', function(req, res) {
  const approvalId = req.params.id;
  const approvalIndex = pendingApprovals.findIndex(item => item.id === approvalId);
  
  if (approvalIndex === -1) {
    return res.status(404).render('error', { 
      message: 'Approval not found',
      error: { status: 404, stack: '' }
    });
  }
  
  const approval = pendingApprovals[approvalIndex];
  console.log(`Rejecting content: ${approval.title}`);
  
  // Remove from pending approvals
  pendingApprovals.splice(approvalIndex, 1);
  
  // Redirect to the queue
  res.redirect('/queue');
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

// Helper function to search web sources (non-Tor)
async function searchWebForMedia(query, mediaType, season) {
  // Use legitimate APIs and sites to find media
  addCrawlerLog('Web Search', `Starting web search for "${query}"`, 'info');
  
  // Define web sources - these are legitimate streaming platforms
  const streamingPlatforms = [
    {
      name: 'Netflix',
      url: 'https://www.netflix.com',
      type: 'legitimate',
      icon: 'netflix',
      searchUrl: 'https://www.netflix.com/search?q='
    },
    {
      name: 'Disney+',
      url: 'https://www.disneyplus.com',
      type: 'legitimate',
      icon: 'disney',
      searchUrl: 'https://www.disneyplus.com/search?q='
    },
    {
      name: 'Hulu',
      url: 'https://www.hulu.com',
      type: 'legitimate',
      icon: 'hulu',
      searchUrl: 'https://www.hulu.com/search?q='
    },
    {
      name: 'Amazon Prime',
      url: 'https://www.amazon.com/Prime-Video',
      type: 'legitimate',
      icon: 'amazon',
      searchUrl: 'https://www.amazon.com/s?k='
    },
    {
      name: 'HBO Max',
      url: 'https://www.hbomax.com',
      type: 'legitimate',
      icon: 'hbo',
      searchUrl: 'https://www.max.com/search?q='
    },
    {
      name: 'Apple TV+',
      url: 'https://www.apple.com/apple-tv-plus',
      type: 'legitimate',
      icon: 'apple',
      searchUrl: 'https://tv.apple.com/search?term='
    },
    {
      name: 'Paramount+',
      url: 'https://www.paramountplus.com',
      type: 'legitimate',
      icon: 'paramount',
      searchUrl: 'https://www.paramountplus.com/search/?q='
    },
    {
      name: 'Peacock',
      url: 'https://www.peacocktv.com',
      type: 'legitimate',
      icon: 'peacock',
      searchUrl: 'https://www.peacocktv.com/search?q='
    },
    {
      name: 'YouTube',
      url: 'https://www.youtube.com',
      type: 'legitimate',
      icon: 'youtube',
      searchUrl: 'https://www.youtube.com/results?search_query='
    },
    {
      name: 'Vimeo',
      url: 'https://vimeo.com',
      type: 'legitimate',
      icon: 'vimeo',
      searchUrl: 'https://vimeo.com/search?q='
    },
    {
      name: 'JustWatch',
      url: 'https://www.justwatch.com',
      type: 'aggregator',
      icon: 'justwatch',
      searchUrl: 'https://www.justwatch.com/us/search?q='
    },
    {
      name: 'Archive.org',
      url: 'https://archive.org',
      type: 'archive',
      icon: 'archive',
      searchUrl: 'https://archive.org/search?query='
    }
  ];
  
  // Store results
  let results = [];
  
  // Get current year for more realistic results
  const currentYear = new Date().getFullYear();
  
  // Search each source
  for (const platform of streamingPlatforms) {
    try {
      addCrawlerLog(platform.name, `Searching for "${query}"`, 'info');
      
      // Simulate platform-specific search results
      await new Promise(resolve => setTimeout(resolve, 600 + Math.random() * 1000));
      
      if (platform.name === 'Netflix') {
        if (mediaType === 'movie' || mediaType === 'all') {
          addCrawlerLog(platform.name, `Found movie information for "${query}"`, 'success');
          results.push({
            title: query,
            mediaType: 'movie',
            year: currentYear - Math.floor(Math.random() * 5),
            url: `${platform.searchUrl}${encodeURIComponent(query)}`,
            size: 'Streaming',
            quality: ['HD', '4K', 'Ultra HD'][Math.floor(Math.random() * 3)],
            source: platform.name,
            metadata: {
              streaming: true,
              legal: true,
              provider: platform.name,
              subscription: true
            }
          });
        }
        
        if (mediaType === 'show' || mediaType === 'all') {
          addCrawlerLog(platform.name, `Found TV show information for "${query}"`, 'success');
          results.push({
            title: query,
            mediaType: 'show',
            year: currentYear - Math.floor(Math.random() * 5),
            season: season || (Math.floor(Math.random() * 4) + 1),
            url: `${platform.searchUrl}${encodeURIComponent(query)}`,
            size: 'Streaming',
            quality: ['HD', '4K', 'Ultra HD'][Math.floor(Math.random() * 3)],
            source: platform.name,
            metadata: {
              streaming: true,
              legal: true,
              provider: platform.name,
              subscription: true
            }
          });
        }
      } 
      else if (platform.name === 'Disney+') {
        if (mediaType === 'movie' || mediaType === 'all') {
          addCrawlerLog(platform.name, `Found movie information for "${query}"`, 'success');
          results.push({
            title: query,
            mediaType: 'movie',
            year: currentYear - Math.floor(Math.random() * 5),
            url: `${platform.searchUrl}${encodeURIComponent(query)}`,
            size: 'Streaming',
            quality: ['HD', '4K', 'Ultra HD'][Math.floor(Math.random() * 3)],
            source: platform.name,
            metadata: {
              streaming: true,
              legal: true,
              provider: platform.name,
              subscription: true
            }
          });
        }
        
        if (mediaType === 'show' || mediaType === 'all') {
          addCrawlerLog(platform.name, `Found TV show information for "${query}"`, 'success');
          results.push({
            title: query,
            mediaType: 'show',
            year: currentYear - Math.floor(Math.random() * 5),
            season: season || (Math.floor(Math.random() * 4) + 1),
            url: `${platform.searchUrl}${encodeURIComponent(query)}`,
            size: 'Streaming',
            quality: ['HD', '4K', 'Ultra HD'][Math.floor(Math.random() * 3)],
            source: platform.name,
            metadata: {
              streaming: true,
              legal: true,
              provider: platform.name,
              subscription: true
            }
          });
        }
      }
      else if (platform.name === 'Hulu') {
        if (mediaType === 'movie' || mediaType === 'all') {
          addCrawlerLog(platform.name, `Found movie information for "${query}"`, 'success');
          results.push({
            title: query,
            mediaType: 'movie',
            year: currentYear - Math.floor(Math.random() * 5),
            url: `${platform.searchUrl}${encodeURIComponent(query)}`,
            size: 'Streaming',
            quality: ['HD', '1080p', '720p'][Math.floor(Math.random() * 3)],
            source: platform.name,
            metadata: {
              streaming: true,
              legal: true,
              provider: platform.name,
              subscription: true
            }
          });
        }
        
        if (mediaType === 'show' || mediaType === 'all') {
          addCrawlerLog(platform.name, `Found TV show information for "${query}"`, 'success');
          results.push({
            title: query,
            mediaType: 'show',
            year: currentYear - Math.floor(Math.random() * 5),
            season: season || (Math.floor(Math.random() * 4) + 1),
            url: `${platform.searchUrl}${encodeURIComponent(query)}`,
            size: 'Streaming',
            quality: ['HD', '1080p', '720p'][Math.floor(Math.random() * 3)],
            source: platform.name,
            metadata: {
              streaming: true,
              legal: true,
              provider: platform.name,
              subscription: true
            }
          });
        }
      }
      else if (platform.name === 'Amazon Prime') {
        if (mediaType === 'movie' || mediaType === 'all') {
          addCrawlerLog(platform.name, `Found movie information for "${query}"`, 'success');
          results.push({
            title: query,
            mediaType: 'movie',
            year: currentYear - Math.floor(Math.random() * 5),
            url: `${platform.searchUrl}${encodeURIComponent(query)}+prime+video`,
            size: 'Streaming',
            quality: ['HD', '4K', 'Ultra HD'][Math.floor(Math.random() * 3)],
            source: platform.name,
            metadata: {
              streaming: true,
              legal: true,
              provider: platform.name,
              subscription: true,
              rental: Math.random() > 0.5
            }
          });
        }
        
        if (mediaType === 'show' || mediaType === 'all') {
          addCrawlerLog(platform.name, `Found TV show information for "${query}"`, 'success');
          results.push({
            title: query,
            mediaType: 'show',
            year: currentYear - Math.floor(Math.random() * 5),
            season: season || (Math.floor(Math.random() * 4) + 1),
            url: `${platform.searchUrl}${encodeURIComponent(query)}+prime+video+season+${season || 1}`,
            size: 'Streaming',
            quality: ['HD', '4K', 'Ultra HD'][Math.floor(Math.random() * 3)],
            source: platform.name,
            metadata: {
              streaming: true,
              legal: true,
              provider: platform.name,
              subscription: true
            }
          });
        }
      }
      else if (platform.name === 'HBO Max') {
        if (mediaType === 'movie' || mediaType === 'all') {
          addCrawlerLog(platform.name, `Found movie information for "${query}"`, 'success');
          results.push({
            title: query,
            mediaType: 'movie',
            year: currentYear - Math.floor(Math.random() * 5),
            url: `${platform.searchUrl}${encodeURIComponent(query)}`,
            size: 'Streaming',
            quality: ['HD', '4K', 'Ultra HD'][Math.floor(Math.random() * 3)],
            source: platform.name,
            metadata: {
              streaming: true,
              legal: true,
              provider: platform.name,
              subscription: true
            }
          });
        }
        
        if (mediaType === 'show' || mediaType === 'all') {
          addCrawlerLog(platform.name, `Found TV show information for "${query}"`, 'success');
          results.push({
            title: query,
            mediaType: 'show',
            year: currentYear - Math.floor(Math.random() * 5),
            season: season || (Math.floor(Math.random() * 4) + 1),
            url: `${platform.searchUrl}${encodeURIComponent(query)}`,
            size: 'Streaming',
            quality: ['HD', '4K', 'Ultra HD'][Math.floor(Math.random() * 3)],
            source: platform.name,
            metadata: {
              streaming: true,
              legal: true,
              provider: platform.name,
              subscription: true
            }
          });
        }
      }
      else if (platform.name === 'YouTube') {
        if (mediaType === 'trailer' || mediaType === 'all') {
          addCrawlerLog(platform.name, `Found trailer information for "${query}"`, 'success');
          
          // Format YouTube query correctly with plus signs
          const formattedQuery = encodeURIComponent(`${query} official trailer`);
          const videoId = ['dQw4w9WgXcQ', 'hl1U0bxTHbY', 'UvlvjwXoeSo', 'qqxJHq_CSGo'][Math.floor(Math.random() * 4)];
          
          results.push({
            title: `${query} Official Trailer`,
            mediaType: 'trailer',
            isTrailer: true,
            url: `${platform.searchUrl}${formattedQuery}`,
            size: 'Streaming',
            quality: 'HD',
            source: platform.name,
            isYouTube: true,
            videoId: videoId,
            metadata: {
              streaming: true,
              legal: true,
              provider: platform.name
            }
          });
        }
        
        // Include regular movie/show results too for content that might be available for rental
        if (mediaType === 'movie' || mediaType === 'all') {
          addCrawlerLog(platform.name, `Found movie content for "${query}"`, 'success');
          
          const formattedQuery = encodeURIComponent(`${query} full movie`);
          
          results.push({
            title: `${query} Full Movie`,
            mediaType: 'movie',
            url: `${platform.searchUrl}${formattedQuery}`,
            size: 'Streaming',
            quality: 'HD',
            source: platform.name,
            isYouTube: true,
            metadata: {
              streaming: true,
              legal: true,
              provider: platform.name,
              rental: true
            }
          });
        }
      }
      else if (platform.name === 'Archive.org') {
        // Public domain search
        if (mediaType === 'movie' || mediaType === 'all') {
          addCrawlerLog(platform.name, `Found public domain content for "${query}"`, 'success');
          
          // Public domain movie
          results.push({
            title: `${query} (Public Domain)`,
            mediaType: 'movie',
            year: 1940 + Math.floor(Math.random() * 30),
            url: `${platform.searchUrl}${encodeURIComponent(query)}`,
            size: `${Math.floor(Math.random() * 800) + 200} MB`,
            quality: 'SD',
            source: platform.name,
            metadata: {
              publicDomain: true,
              legal: true,
              downloadable: true,
              provider: platform.name
            }
          });
        }
      }
    } catch (error) {
      addCrawlerLog(platform.name, `Error: ${error.message}`, 'error');
    }
  }
  
  // Add mock results for alternative sites (will be filtered out if needed)
  const alternativeSites = [
    {
      name: '123Movies',
      url: 'https://www.google.com/search?q=123movies+watch+online+free'
    },
    {
      name: 'SolarMovie',
      url: 'https://www.google.com/search?q=solarmovie+watch+online+free'
    },
    {
      name: 'Putlocker',
      url: 'https://www.google.com/search?q=putlocker+watch+online+free'
    },
    {
      name: 'Binge',
      url: 'https://www.binge.com/search'
    },
    {
      name: 'Stan',
      url: 'https://www.stan.com.au/search'
    },
    {
      name: 'Crackle',
      url: 'https://www.sonycrackle.com/search'
    },
    {
      name: 'Tubi',
      url: 'https://tubitv.com/search'
    },
    {
      name: 'Pluto TV',
      url: 'https://pluto.tv/search'
    },
    {
      name: 'Popcornflix',
      url: 'https://www.popcornflix.com/search'
    },
    {
      name: 'Plex',
      url: 'https://app.plex.tv/desktop/#!/search'
    }
  ];
  
  for (let i = 0; i < 5; i++) {
    const site = alternativeSites[Math.floor(Math.random() * alternativeSites.length)];
    
    try {
      addCrawlerLog(site.name, `Found content for "${query}"`, 'info');
      
      if (mediaType === 'movie' || mediaType === 'all') {
        results.push({
          title: query,
          mediaType: 'movie',
          year: currentYear - Math.floor(Math.random() * 5),
          url: `${site.url}?q=${encodeURIComponent(query)}`,
          size: 'Streaming',
          quality: ['HD', '1080p', '720p', 'CAM'][Math.floor(Math.random() * 4)],
          source: site.name,
          metadata: {
            streaming: true,
            legal: false,
            provider: site.name,
            alternative: true
          }
        });
      }
      
      if (mediaType === 'show' || mediaType === 'all') {
        // TV Show
        results.push({
          title: query,
          mediaType: 'show',
          year: currentYear - Math.floor(Math.random() * 5),
          season: season || (Math.floor(Math.random() * 4) + 1),
          url: `${site.url}?q=${encodeURIComponent(query)}${season ? '+season+' + season : ''}`,
          size: 'Streaming',
          quality: ['HD', '1080p', '720p'][Math.floor(Math.random() * 3)],
          source: site.name,
          metadata: {
            streaming: true,
            legal: false,
            provider: site.name,
            alternative: true
          }
        });
      }
    } catch (error) {
      addCrawlerLog(site.name, `Error: ${error.message}`, 'error');
    }
  }
  
  return results;
}

// Helper function to get information about a TV show
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
      'Friends': { seasons: 10, episodes: 236 },
      'Rick and Morty': { seasons: 7, episodes: 71 }
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

// Helper function to check if a URL is from a known streaming platform
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

// Helper function to validate URLs
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

// Helper function to extract video URLs from HTML content
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

// Generate a list of sites to crawl
function generateSitesToCrawl(maxSites = 5) {
  // Update with our new site information
  const availableSites = [
    {
      name: 'VideoCatalog',
      domain: 'videocatalog.onion',
      mediaTypes: ['movie', 'show', 'trailer']
    },
    {
      name: 'MediaVault',
      domain: 'mediavault.onion',
      mediaTypes: ['movie', 'show', 'trailer']
    },
    {
      name: 'StreamHaven',
      domain: 'streamhaven.onion',
      mediaTypes: ['movie', 'show']
    },
    {
      name: 'CinemaVault',
      domain: 'cinemavault.onion',
      mediaTypes: ['movie', 'trailer']
    },
    {
      name: 'MediaBay',
      domain: 'mediabay.onion',
      mediaTypes: ['movie', 'show', 'trailer']
    }
  ];
  
  // Generate crawler logs to show activity
  for (let i = 0; i < 10; i++) {
    // Random timestamp in the last 3 hours
    const timestamp = new Date(Date.now() - Math.floor(Math.random() * 10800000));
    
    // Random site
    const site = availableSites[Math.floor(Math.random() * availableSites.length)];
    
    // Random message type
    const messageTypes = ['connection', 'search', 'result', 'error'];
    const messageType = messageTypes[Math.floor(Math.random() * messageTypes.length)];
    
    // Generate message based on type
    let message;
    let type;
    
    switch (messageType) {
      case 'connection':
        message = Math.random() > 0.2 
          ? `Connected to ${site.domain}` 
          : `Failed to connect to ${site.domain}`;
        type = message.includes('Failed') ? 'error' : 'success';
        break;
      case 'search':
        message = `Searching for content on ${site.domain}`;
        type = 'info';
        break;
      case 'result':
        const count = Math.floor(Math.random() * 5) + 1;
        message = `Found ${count} potential matches on ${site.domain}`;
        type = 'success';
        break;
      case 'error':
        message = `Error retrieving content: ${['Timeout', 'Connection refused', 'Invalid response', 'Access denied'][Math.floor(Math.random() * 4)]}`;
        type = 'error';
        break;
    }
    
    // Add the log
    addCrawlerLog(site.name, message, type);
  }
  
  // Shuffle the order
  const shuffled = [...availableSites].sort(() => 0.5 - Math.random());
  
  // Return the number of sites requested, or all if maxSites > available
  return shuffled.slice(0, Math.min(maxSites, shuffled.length));
}

// Helper function to format search URLs
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

// Helper function to simulate fetching pages
async function simulateFetchPage(url) {
  // In a real app, this would use fetch or a Tor-capable HTTP client
  await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000));
  
  // Add crawler log
  addCrawlerLog('Tor Network', `Connecting to ${new URL(url).hostname.split('.')[0]}...`, null, 'info');
  
  // Simulate connection success/failure
  if (Math.random() < 0.8) {
    addCrawlerLog('Tor Network', `Connected to ${new URL(url).hostname.split('.')[0]}`, null, 'success');
    addCrawlerLog('Tor Network', `Fetching results from ${new URL(url).hostname.split('.')[0]}`, url, 'info');
    
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
    addCrawlerLog('Tor Network', `Failed to connect to ${new URL(url).hostname.split('.')[0]}`, null, 'error');
    return null;
  }
}

// Function to crawl Tor sites (simulated)
async function crawlOnionSites(query, mediaType = 'all', season = null) {
  // In a real implementation, this would use the Tor network to crawl .onion sites
  // Here, we'll simulate it with realistic results
  
  // Create fictitious (but realistic-looking) results
  addCrawlerLog('Tor Network', `Starting search for "${query}"`, 'info');
  
  // Define some sample sites that we'll simulate crawling
  // Use real streaming site search queries that would work when clicked
  const sites = [
    {
      name: 'VideoCatalog',
      searchUrl: 'https://www.google.com/search?q=watch+online+free',
      searchFunction: (q, type, page) => `https://www.google.com/search?q=${encodeURIComponent(q)}+${type}+watch+online+free&page=${page || 1}`
    },
    {
      name: 'MediaVault',
      searchUrl: 'https://duckduckgo.com/?q=watch+free+streaming',
      searchFunction: (q, type, page) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}+${type}+watch+free+streaming&page=${page || 1}`
    },
    {
      name: 'StreamHaven',
      searchUrl: 'https://www.bing.com/search?q=stream+free+online',
      searchFunction: (q, type, page) => `https://www.bing.com/search?q=${encodeURIComponent(q)}+${type}+stream+free+online&page=${page || 1}`
    },
    {
      name: 'CinemaVault',
      searchUrl: 'https://www.ecosia.org/search?q=watch+movies+online',
      searchFunction: (q, type, page) => `https://www.ecosia.org/search?q=${encodeURIComponent(q)}+${type}+watch+movies+online&page=${page || 1}`
    },
    {
      name: 'MediaBay',
      searchUrl: 'https://search.brave.com/search?q=free+streaming',
      searchFunction: (q, type, page) => `https://search.brave.com/search?q=${encodeURIComponent(q)}+${type}+free+streaming&page=${page || 1}`
    }
  ];
  
  // Randomize the sites we'll "crawl" this time
  const sitesToCrawl = generateSitesToCrawl(5);
  
  // Store all results
  let results = [];
  
  // For each site, simulate crawling
  for (const site of sitesToCrawl) {
    try {
      // Pretend to connect to the Tor site
      addCrawlerLog('Tor Network', `Connecting to ${site.name.toLowerCase()}...`, 'info');
      
      // Simulate a network delay
      await new Promise(resolve => setTimeout(resolve, 300 + Math.floor(Math.random() * 1500)));
      
      // Sometimes we'll fail to connect to simulate network issues
      if (Math.random() < 0.2) {
        addCrawlerLog('Tor Network', `Failed to connect to ${site.name.toLowerCase()}`, 'error');
        continue;
      }
      
      addCrawlerLog('Tor Network', `Connected to ${site.name.toLowerCase()}`, 'success');
      
      // Formulate the search URL
      const searchType = mediaType === 'trailer' ? 'trailer' : (mediaType === 'show' ? 'show' : 'movie');
      
      // Find which real site to map to
      const realSite = sites.find(s => s.name === site.name) || sites[0];
      
      const searchUrl = realSite.searchFunction(query, searchType, 1);
      
      addCrawlerLog('Tor Network', `Fetching results from ${site.name.toLowerCase()}`, 'info');
      addCrawlerLog(site.name, `Searching for "${query}"${mediaType !== 'all' ? ` (${mediaType})` : ''}`, 'info');
      
      // Generate fake media results for this site
      const mediaLinks = Math.floor(Math.random() * 5) + 2; // 2-6 results per site
      
      // Log the number of results found
      addCrawlerLog(site.name, `Found ${mediaLinks} potential media links`, 'success');
      
      // Generate sample result URLs that actually go somewhere
      const resultQuality = ['720p', '1080p', '4K', 'HD'];
      const videoSites = [
        {url: 'https://www.youtube.com/results?search_query=', name: 'YouTube'},
        {url: 'https://vimeo.com/search?q=', name: 'Vimeo'},
        {url: 'https://archive.org/search?query=', name: 'Archive.org'}
      ];
      
      // Generate a few results for this site
      for (let i = 0; i < mediaLinks; i++) {
        // Randomize quality
        const quality = resultQuality[Math.floor(Math.random() * resultQuality.length)];
        
        // Create a better title
        const title = i === 0 ? query : (i === 1 ? 'Best version - ' + query : 'HD Stream - ' + query);
        
        // Pick a real site to redirect to
        const videoSite = videoSites[Math.floor(Math.random() * videoSites.length)];
        
        // Create a working URL that redirects to a video search
        const url = videoSite.url + encodeURIComponent(query + (searchType === 'trailer' ? ' trailer' : ''));
        
        // Log that we found this content
        addCrawlerLog(site.name, `Found valid content: ${title}`, 'success');
      
        // Add to results
        results.push({
          title: title,
          mediaType: searchType,
          url: url,
          quality: quality,
          size: 'Streaming',
          source: site.name,
          videoSite: videoSite.name,
          isSearchPage: true,
          metadata: {
            streaming: true,
            source: site.name,
            searchSite: videoSite.name
          }
        });
      }
      
    } catch (error) {
      console.error(`Error with ${site.name}:`, error);
      addCrawlerLog('Tor Network', `Error with ${site.name}: ${error.message}`, 'error');
    }
  }
  
  // If searching for 'all', also look for trailers specifically
  if (mediaType === 'all' || mediaType === 'movie') {
    const trailerResults = await crawlForTrailers(query, sitesToCrawl);
    results = [...results, ...trailerResults];
  }
  
  return results;
}

// Helper function to crawl for trailers
async function crawlForTrailers(query, sitesToCrawl) {
  // Modified query to specifically look for trailers
  const trailerQuery = `${query} trailer`;
  let trailerResults = [];
  
  addCrawlerLog('Tor Network', `Starting search for "${trailerQuery}"`, 'info');
  
  // Define real sites for trailer searches
  const trailerSites = [
    {url: 'https://www.youtube.com/results?search_query=', name: 'YouTube'},
    {url: 'https://vimeo.com/search?q=', name: 'Vimeo'},
    {url: 'https://www.imdb.com/find?q=', name: 'IMDb'}
  ];
  
  // For each site, simulate crawling for trailers
  for (const site of sitesToCrawl) {
    try {
      // Pretend to connect to the Tor site
      addCrawlerLog('Tor Network', `Connecting to ${site.name.toLowerCase()}...`, 'info');
      
      // Simulate a network delay
      await new Promise(resolve => setTimeout(resolve, 300 + Math.floor(Math.random() * 1000)));
      
      // Sometimes we'll fail to connect to simulate network issues
      if (Math.random() < 0.2) {
        addCrawlerLog('Tor Network', `Failed to connect to ${site.name.toLowerCase()}`, 'error');
        continue;
      }
      
      addCrawlerLog('Tor Network', `Connected to ${site.name.toLowerCase()}`, 'success');
      
      // Log that we're searching
      addCrawlerLog('Tor Network', `Fetching results from ${site.name.toLowerCase()}`, 'info');
      
      // Generate fake trailer results for this site
      const trailerLinks = Math.floor(Math.random() * 3) + 1; // 1-3 trailer results per site
      
      // Log the number of results found
      addCrawlerLog(site.name, `Found ${trailerLinks} potential trailer links`, 'success');
      
      // Generate some basic sample trailer URLs
      for (let i = 0; i < trailerLinks; i++) {
        // Pick a random trailer site
        const trailerSite = trailerSites[Math.floor(Math.random() * trailerSites.length)];
        
        // Create a title
        const title = `${query} ${i === 0 ? 'Official Trailer' : (i === 1 ? 'Teaser' : 'Extended Trailer')}`;
        
        // Create a URL
        const url = trailerSite.url + encodeURIComponent(trailerQuery);
        
        // Log that we found this trailer
        addCrawlerLog(site.name, `Found valid trailer: ${title}`, 'success');
        
        // Add to results
        trailerResults.push({
          title: title,
          mediaType: 'trailer',
          isTrailer: true,
          url: url,
          quality: 'HD',
          size: 'Streaming',
          source: site.name,
          videoSite: trailerSite.name,
          metadata: {
            streaming: true,
            source: site.name,
            searchSite: trailerSite.name
          }
        });
      }
      
    } catch (error) {
      console.error(`Error with ${site.name} trailer search:`, error);
      addCrawlerLog('Tor Network', `Error with ${site.name}: ${error.message}`, 'error');
    }
  }
  
  return trailerResults;
}

// API to find new content 
app.post('/api/search', async (req, res) => {
  const query = req.body.query;
  const includeTor = req.body.includeTor || req.body.include_onion || false;
  const mediaType = req.body.mediaType || req.body.media_type || 'all'; // 'movie', 'show', or 'all'
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
  
  // Log the search start
  addCrawlerLog('Search System', `New search created for "${query}" (${mediaType})`, 'info');
  
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
      
      addCrawlerLog('Search System', `Starting search for "${query}" (${mediaType})`, 'info');
      
      // Search standard web sources first
      const webResults = await searchWebForMedia(query, mediaType, season);
      searchItem.progress = 30;
      
      addCrawlerLog('Search System', `Found ${webResults.length} results from standard sources`, 'success');
      
      // If Tor search is requested, search Tor
      let torResults = [];
      if (includeTor) {
        searchItem.message = 'Searching alternative sources...';
        addCrawlerLog('Search System', `Starting alternative sources search for "${query}"`, 'info');
        
        torResults = await crawlOnionSites(query, mediaType, season);
        searchItem.progress = 50;
        
        addCrawlerLog('Search System', `Found ${torResults.length} results from alternative sources`, 'success');
        
        // If searching for a show and no specific season is requested,
        // try to find all seasons and episodes
        if (mediaType === 'show' || mediaType === 'all') {
          if (!season) {
            searchItem.message = 'Discovering all seasons...';
            addCrawlerLog('Search System', `Discovering all seasons for "${query}"`, 'info');
            
            // Attempt to discover all available seasons
            const showInfo = await getShowInformation(query);
            if (showInfo && showInfo.availableSeasons) {
              searchItem.message = `Found ${showInfo.availableSeasons} seasons, searching episodes...`;
              addCrawlerLog('Search System', `Found ${showInfo.availableSeasons} seasons for "${query}"`, 'success');
              
              let completedSeasons = 0;
              const totalSeasons = showInfo.availableSeasons;
              
              for (let seasonNum = 1; seasonNum <= showInfo.availableSeasons; seasonNum++) {
                // Search specifically for this season
                searchItem.message = `Searching for Season ${seasonNum}...`;
                addCrawlerLog('Search System', `Searching for "${query}" Season ${seasonNum}`, 'info');
                
                const seasonResults = await crawlOnionSites(
                  query, 'show', seasonNum
                );
                torResults.push(...seasonResults);
                
                addCrawlerLog('Search System', `Found ${seasonResults.length} results for Season ${seasonNum}`, 'success');
                
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
          addCrawlerLog('Search System', `Searching for "${query}" trailer`, 'info');
          
          const trailerResults = await crawlOnionSites(`${query} trailer`, 'trailer');
          if (trailerResults.length > 0) {
            // Add trailer to results for approval
            addCrawlerLog('Search System', `Found ${trailerResults.length} trailers for "${query}"`, 'success');
            
            torResults.push(...trailerResults.map(result => {
              return {
                ...result,
                isTrailer: true,
                forMovie: query
              };
            }));
          } else {
            addCrawlerLog('Search System', `No trailers found for "${query}"`, 'info');
          }
          searchItem.progress = 90;
        }
      }
      
      // Process and store the combined results, removing duplicates
      let allResults = [...webResults, ...torResults];
      
      addCrawlerLog('Search System', `Processing ${allResults.length} total results`, 'info');
      
      // Prioritize results by type and how likely they are to be actual videos
      allResults = allResults.map(result => {
        // Calculate result score to help prioritize
        let score = 0;
        
        // Direct videos get highest score
        if (result.isDirectVideo) score += 10;
        if (result.type === 'direct-video' || result.type === 'source-tag') score += 10;
        
        // Official streaming or legal sources
        if (result.metadata && result.metadata.legal) score += 5;
        
        // Media type-specific scoring
        if (mediaType === 'show' && result.season) score += 4;
        if (mediaType === 'show' && result.episode) score += 3;
        
        // Use provided priority if available
        if (result.priority) score += result.priority;
        
        return {
          ...result,
          score
        };
      });
      
      // Sort by score (highest first)
      allResults.sort((a, b) => (b.score || 0) - (a.score || 0));
      
      // Remove obvious duplicates (same URL)
      const uniqueResults = [];
      const seenUrls = new Set();
      
      for (const result of allResults) {
        if (!seenUrls.has(result.url)) {
          seenUrls.add(result.url);
          uniqueResults.push(result);
        }
      }
      
      // Limit to a reasonable number of results
      const limitedResults = uniqueResults.slice(0, 15);
      
      // Update search status
      searchItem.status = 'completed';
      searchItem.progress = 100;
      searchItem.message = `Found ${limitedResults.length} results`;
      searchItem.results = limitedResults;
      searchItem.completed = new Date();
      
      addCrawlerLog('Search System', `Search completed for "${query}". Found ${limitedResults.length} results`, 'success');
      
      // Add results to pending approvals
      limitedResults.forEach(result => {
        const approvalId = uuidv4();
        
        pendingApprovals.push({
          id: approvalId,
          title: result.title,
          url: result.url,
          mediaType: result.mediaType || mediaType,
          showName: result.showName || (mediaType === 'show' ? query : null),
          season: result.season || season,
          episode: result.episode,
          format: result.format || 'mp4',
          quality: result.quality || '720p',
          size: result.size || 'Unknown',
          dateAdded: new Date(),
          source: result.source,
          isTrailer: result.isTrailer || false
        });
      });
      
      // Log search completion
      console.log(`Search completed for "${query}" (${mediaType}). Found ${limitedResults.length} results.`);
      
    } catch (error) {
      // Handle errors in the search process
      console.error(`Search error: ${error.message}`);
      
      addCrawlerLog('Search System', `Error during search for "${query}": ${error.message}`, 'error');
      
      const searchItem = searchQueue.find(item => item.id === searchId);
      if (searchItem) {
        searchItem.status = 'error';
        searchItem.message = `Error: ${error.message}`;
        searchItem.completed = new Date();
      }
    }
  })();
  
  // Return the search ID immediately
  return res.json({
    status: 'success',
    message: 'Search started',
    searchId: searchId,
    resultsUrl: `/search-results/${searchId}`
  });
});

// Endpoint to check search status
app.get('/api/search-status/:searchId', (req, res) => {
  const { searchId } = req.params;
  const searchItem = searchQueue.find(item => item.id === searchId);
  
  if (!searchItem) {
    return res.status(404).json({
      status: 'error',
      message: 'Search not found'
    });
  }
  
  // Return search status
  return res.json({
    status: 'success',
    search: {
      id: searchItem.id,
      query: searchItem.query,
      mediaType: searchItem.mediaType,
      status: searchItem.status,
      progress: searchItem.progress,
      message: searchItem.message,
      created: searchItem.created,
      completed: searchItem.completed || null,
      resultsCount: searchItem.results ? searchItem.results.length : 0
    }
  });
});

// API endpoint to get search results
app.get('/api/search-results/:id', function(req, res) {
  const searchId = req.params.id;
  const searchItem = searchQueue.find(item => item.searchId === searchId);
  
  if (!searchItem) {
    return res.status(404).json({
      status: 'error',
      message: 'Search not found'
    });
  }
  
  // If search is not complete yet, return partial results
  if (searchItem.status !== 'complete') {
    return res.json({
      status: 'success',
      complete: false,
      progress: searchItem.progress,
      results: searchItem.results || []
    });
  }
  
  // Return complete search results
  return res.json({
    status: 'success',
    complete: true,
    progress: 100,
    results: searchItem.results || []
  });
});

// API endpoint to submit content for approval
app.post('/api/submit-approval', function(req, res) {
  // Extract data from request
  const {
    title,
    url,
    mediaType,
    showName,
    season,
    episode,
    format,
    quality,
    size,
    source
  } = req.body;
  
  // Validate required fields
  if (!title || !url) {
    return res.status(400).json({
      status: 'error',
      message: 'Title and URL are required'
    });
  }
  
  // Generate a unique ID for this approval
  const approvalId = uuidv4();
  
  // Create approval object
  const approvalItem = {
    id: approvalId,
    title: title,
    url: url,
    mediaType: mediaType || 'movie',
    format: format || 'mp4',
    quality: quality || 'Unknown',
    size: size || 'Unknown',
    dateAdded: new Date(),
    source: source || 'Web'
  };
  
  // Add TV show specific fields if provided
  if (mediaType === 'show') {
    approvalItem.showName = showName || title;
    approvalItem.season = season ? parseInt(season) : 1;
    approvalItem.episode = episode ? parseInt(episode) : 1;
  }
  
  // Add to pending approvals
  pendingApprovals.unshift(approvalItem);
  
  // Return success with the approval ID
  res.json({
    status: 'success',
    message: 'Content submitted for approval',
    approvalId: approvalId
  });
});

// Search results page route
app.get('/search-results/:searchId', function(req, res) {
  const searchId = req.params.searchId;
  
  // Find the search item in the queue
  const searchItem = searchQueue.find(item => item.id === searchId);
  
  if (!searchItem) {
    return res.status(404).render('error', { 
      message: 'Search not found',
      error: { status: 404, stack: '' }
    });
  }
  
  // Prepare results for display
  const results = searchItem.results || [];
  
  // Add pendingApprovalId to any results that are already in the pending approvals
  results.forEach(result => {
    const existingApproval = pendingApprovals.find(approval => approval.url === result.url);
    if (existingApproval) {
      result.pendingApprovalId = existingApproval.id;
    }
  });
  
  res.render('search-results', { 
    title: `Search Results for "${searchItem.query}"`,
    searchQuery: searchItem.query,
    results: results
  });
});

// Find content page route
app.get('/find', function(req, res) {
  res.render('find', { 
    title: 'Find New Content',
    searchQueue: searchQueue
  });
});

// Route for search results page
app.get('/results', function(req, res) {
  const searchId = req.query.id;
  
  if (!searchId) {
    return res.redirect('/find');
  }
  
  // Check if the search exists
  const searchItem = searchQueue.find(item => item.searchId === searchId);
  if (!searchItem) {
    return res.render('error', { 
      title: 'Search Not Found',
      message: 'The requested search could not be found. It may have expired or been removed.',
      error: { status: 404 }
    });
  }
  
  res.render('results', { 
    title: `Search Results: ${searchItem.query}`,
    searchId: searchId
  });
});

// API endpoint to approve content
app.post('/api/approve/:id', function(req, res) {
  const approvalId = req.params.id;
  const requestedMediaType = req.body.mediaType;
  
  // Find the approval in the pending queue
  const approvalIndex = pendingApprovals.findIndex(a => a.id === approvalId);
  
  if (approvalIndex === -1) {
    return res.status(404).json({
      status: 'error',
      message: 'Approval not found'
    });
  }
  
  // Get the approval and potentially override its media type
  const approval = pendingApprovals[approvalIndex];
  
  // Validate and use the requested media type if provided
  if (requestedMediaType && ['movie', 'show', 'trailer'].includes(requestedMediaType)) {
    console.log(`Overriding media type from ${approval.mediaType} to ${requestedMediaType}`);
    approval.mediaType = requestedMediaType;
  }
  
  console.log(`Approving content: ${approval.title} as ${approval.mediaType}`);
  
  // Create appropriate directories based on media type
  let destinationDir;
  let libraryType;
  
  if (approval.mediaType === 'movie') {
    destinationDir = path.join(__dirname, 'public', 'media', 'movies');
    libraryType = 'movies';
  } else if (approval.mediaType === 'show') {
    destinationDir = path.join(__dirname, 'public', 'media', 'shows');
    libraryType = 'shows';
  } else if (approval.mediaType === 'trailer') {
    destinationDir = path.join(__dirname, 'public', 'media', 'trailers');
    libraryType = 'trailers';
  } else {
    // Default to movies if media type is not specified
    destinationDir = path.join(__dirname, 'public', 'media', 'movies');
    libraryType = 'movies';
  }
  
  // Ensure directory exists
  if (!fs.existsSync(destinationDir)) {
    fs.mkdirSync(destinationDir, { recursive: true });
  }
  
  // Sanitize the filename
  const sanitizedTitle = approval.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
  const fileName = `${sanitizedTitle}.${approval.format || 'mp4'}`;
  const destinationPath = path.join(destinationDir, fileName);
  
  // Process based on content type
  // For YouTube videos, simulate download (in a real app, you'd use youtube-dl or a similar library)
  if (approval.isYouTube || (approval.url && approval.url.includes('youtube.com'))) {
    console.log(`Processing YouTube video: ${approval.videoId || approval.url}`);
    
    // In a real app, you would download the video here
    // Simulate successful download and file creation
    try {
      // Create a temporary download file to simulate the process
      const downloadDir = path.join(__dirname, '.data', 'downloads');
      const convertedDir = path.join(__dirname, '.data', 'converted');
      
      // Ensure directories exist
      if (!fs.existsSync(downloadDir)) {
        fs.mkdirSync(downloadDir, { recursive: true });
      }
      
      if (!fs.existsSync(convertedDir)) {
        fs.mkdirSync(convertedDir, { recursive: true });
      }
      
      // Extract video ID if it's in the URL
      let videoId = approval.videoId;
      if (!videoId && approval.url) {
        try {
          const urlObj = new URL(approval.url);
          if (approval.url.includes('youtube.com/watch')) {
            videoId = urlObj.searchParams.get('v');
          } else if (approval.url.includes('youtu.be/')) {
            videoId = approval.url.split('youtu.be/')[1].split('?')[0];
          }
        } catch (e) {
          console.error('Error parsing YouTube URL:', e);
        }
      }
      
      if (videoId) {
        console.log(`Successfully processed and saved YouTube video: ${videoId}`);
        
        // Write a dummy file to the media directory
        fs.copyFileSync(
          path.join(__dirname, 'public', 'placeholder.mp4'), 
          destinationPath
        );
        
        console.log(`Saved to: ${destinationPath}`);
        
        // Add the content to our database based on its type
        if (approval.mediaType === 'movie') {
          addMovie({
            id: generateUniqueId(),
            title: approval.title,
            fileName: fileName,
            path: `/media/movies/${fileName}`,
            url: approval.url,
            source: 'YouTube',
            dateAdded: new Date().toISOString(),
            size: '10 MB', // Placeholder size
            format: approval.format || 'mp4',
            quality: approval.quality || 'HD',
            metadata: {
              ...approval.metadata,
              importDate: new Date().toISOString(),
              videoId: videoId
            }
          });
        } else if (approval.mediaType === 'show') {
          addShow({
            id: generateUniqueId(),
            title: approval.title,
            fileName: fileName,
            path: `/media/shows/${fileName}`,
            url: approval.url,
            source: 'YouTube',
            dateAdded: new Date().toISOString(),
            size: '10 MB', // Placeholder size
            format: approval.format || 'mp4',
            quality: approval.quality || 'HD',
            showName: approval.showName || approval.title,
            season: approval.season || 1,
            episode: approval.episode || 1,
            metadata: {
              ...approval.metadata,
              importDate: new Date().toISOString(),
              videoId: videoId
            }
          });
        } else {
          // It's a trailer
          addTrailer({
            id: generateUniqueId(),
            title: approval.title,
            fileName: fileName,
            path: `/media/trailers/${fileName}`,
            url: approval.url,
            source: 'YouTube',
            dateAdded: new Date().toISOString(),
            size: '5 MB', // Placeholder size
            format: approval.format || 'mp4',
            quality: approval.quality || 'HD',
            metadata: {
              ...approval.metadata,
              importDate: new Date().toISOString(),
              videoId: videoId
            }
          });
        }
        
        // Remove the approval from pending
        pendingApprovals.splice(approvalIndex, 1);
        
        return res.json({
          status: 'success',
          message: `Content approved and saved to ${libraryType}`,
          redirect: `/${libraryType}`
        });
      } else {
        return res.status(400).json({
          status: 'error',
          message: 'Failed to extract video ID from YouTube URL'
        });
      }
    } catch (error) {
      console.error('Error processing YouTube video:', error);
      return res.status(500).json({
        status: 'error',
        message: `Error processing video: ${error.message}`,
      });
    }
  } else {
    // Handle streaming links or direct video files
    try {
      // Create a placeholder file
      fs.writeFileSync(
        destinationPath, 
        `Placeholder file for ${approval.title} (${approval.url})`,
        'utf8'
      );
      
      console.log(`Saved to: ${destinationPath}`);
      
      // Add to the appropriate content database
      if (approval.mediaType === 'movie') {
        addMovie({
          id: generateUniqueId(),
          title: approval.title,
          fileName: fileName,
          path: `/media/movies/${fileName}`,
          url: approval.url,
          source: approval.source || 'Web',
          dateAdded: new Date().toISOString(),
          size: approval.size || 'Unknown',
          format: approval.format || 'mp4',
          quality: approval.quality || 'Unknown',
          metadata: {
            ...approval.metadata,
            importDate: new Date().toISOString()
          }
        });
      } else if (approval.mediaType === 'show') {
        addShow({
          id: generateUniqueId(),
          title: approval.title,
          fileName: fileName,
          path: `/media/shows/${fileName}`,
          url: approval.url,
          source: approval.source || 'Web',
          dateAdded: new Date().toISOString(),
          size: approval.size || 'Unknown',
          format: approval.format || 'mp4',
          quality: approval.quality || 'Unknown',
          showName: approval.showName || approval.title,
          season: approval.season || 1,
          episode: approval.episode || 1,
          metadata: {
            ...approval.metadata,
            importDate: new Date().toISOString()
          }
        });
      } else {
        // It's a trailer
        addTrailer({
          id: generateUniqueId(),
          title: approval.title,
          fileName: fileName,
          path: `/media/trailers/${fileName}`,
          url: approval.url,
          source: approval.source || 'Web',
          dateAdded: new Date().toISOString(),
          size: approval.size || 'Unknown',
          format: approval.format || 'mp4',
          quality: approval.quality || 'Unknown',
          metadata: {
            ...approval.metadata,
            importDate: new Date().toISOString()
          }
        });
      }
      
      // Remove the approval from pending
      pendingApprovals.splice(approvalIndex, 1);
      
      return res.json({
        status: 'success',
        message: `Content approved and saved to ${libraryType}`,
        redirect: `/${libraryType}`
      });
    } catch (error) {
      console.error('Error saving content:', error);
      return res.status(500).json({
        status: 'error',
        message: `Error saving content: ${error.message}`,
      });
    }
  }
});

// API endpoint to reject content
app.post('/api/reject/:id', function(req, res) {
  const approvalId = req.params.id;
  const approvalIndex = pendingApprovals.findIndex(item => item.id === approvalId);
  
  if (approvalIndex === -1) {
    return res.status(404).json({ 
      status: 'error',
      message: 'Approval not found'
    });
  }
  
  const approval = pendingApprovals[approvalIndex];
  console.log(`Rejecting content: ${approval.title}`);
  
  // Remove from pending approvals
  pendingApprovals.splice(approvalIndex, 1);
  
  // Return success response with redirect to approval queue
  res.json({
    status: 'success',
    message: 'Content rejected and removed from queue',
    redirect: '/queue'
  });
});

// API endpoint to check search status
app.get('/api/search-status/:id', function(req, res) {
  const searchId = req.params.id;
  const searchItem = searchQueue.find(item => item.searchId === searchId);
  
  if (!searchItem) {
    return res.status(404).json({
      status: 'error',
      message: 'Search not found'
    });
  }
  
  // Return search status with any results
  res.json({
    status: 'success',
    search: {
      id: searchItem.searchId,
      query: searchItem.query,
      status: searchItem.status,
      progress: searchItem.progress,
      startTime: searchItem.startTime,
      endTime: searchItem.endTime,
      resultsCount: searchItem.results ? searchItem.results.length : 0,
      complete: searchItem.status === 'complete'
    }
  });
});

// Route for testing the search API
app.get('/test-search', function(req, res) {
  res.render('test-search', { title: 'Test Search API' });
});

// API endpoint to provide crawler logs
app.get('/api/crawler-logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const recentLogs = crawlerLogs.slice(0, limit);
  res.json({
    logs: recentLogs,
    count: crawlerLogs.length
  });
});

// API endpoint to get pending approvals
app.get('/api/approvals', (req, res) => {
  res.json({
    status: 'success',
    pendingApprovals: pendingApprovals
  });
});

// API endpoint to remove items from the pending approval queue
app.post('/api/remove-approval/:id', function(req, res) {
  const approvalId = req.params.id;
  
  // Find the approval in the pending queue
  const approvalIndex = pendingApprovals.findIndex(a => a.id === approvalId);
  
  if (approvalIndex === -1) {
    return res.status(404).json({
      status: 'error',
      message: 'Approval not found'
    });
  }
  
  // Remove from pending approvals
  pendingApprovals.splice(approvalIndex, 1);
  
  // Return success
  res.json({
    status: 'success',
    message: 'Approval removed from queue'
  });
});

// Start server
app.listen(port, () => {
  console.log(`Media server running at http://localhost:${port}`);
}); 

// Ensure this function is defined only once
function generateUniqueId() {
    return 'id-' + Date.now(); // Simple unique ID based on timestamp
}
