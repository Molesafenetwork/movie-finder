# Media Server with Tor Crawling Capabilities

A web-based media server with the ability to search, stream, and organize your video content. This application includes advanced features like Tor network crawling to find TV shows, movies, and trailers.

## Features

- **Media Organization**: Automatically organizes TV shows by seasons and episodes
- **Video Streaming**: Stream your media directly in the browser
- **Content Discovery**: Search for new content across both standard web and Tor network sources
- **TV Show Completeness**: When searching for TV shows, the app attempts to find all seasons and episodes
- **Movie Trailer Support**: Automatically attempts to find and link trailers to movies
- **Responsive Design**: Works well on desktop and mobile devices

## Setup and Installation

### Prerequisites

- Node.js (v16 or newer)
- Tor service (optional, for accessing .onion sites)

### Installation

1. Clone the repository
2. Install dependencies:
   ```
   npm install
   ```
3. Start the application:
   ```
   npm start
   ```
4. Access the application at `http://localhost:3000`

### Configuring Tor Access

To enable Tor network crawling:

1. Install the Tor service on your system
2. Ensure Tor is running with SOCKS proxy on port 9050 (default)
3. Check the "Include additional sources" option when searching for content

## Using the Application

### Finding TV Shows and Movies

1. Click the "Search Online" button
2. Enter the title of the TV show or movie you want to find
3. Select the content type (All, Movie, or TV Show)
4. For TV shows, you can:
   - Select "All Seasons" to find the complete series
   - Select a specific season to find only that season
5. Check "Include additional sources" to search Tor network (recommended for rare content)
6. Click "Search" and wait for results

### Organizing Your Media

The application automatically organizes your media:

- **TV Shows**: Grouped by show name, then by season and episode number
- **Movies**: Listed with their trailers when available

### File Naming Recommendations

For best results, name your files using the following patterns:

- **TV Shows**: 
  - `ShowName.S01E01.mp4` (standard format)
  - `Show.Name.1x01.mp4` (alternate format)

- **Movies**:
  - `MovieName.mp4`

- **Trailers**:
  - `MovieName.Trailer.mp4`

## Deployment on Glitch.com

This application is compatible with Glitch.com's hosting:

1. Create a new project on Glitch
2. Import this repository
3. The application will automatically run

Note: For Tor functionality on Glitch, you may need to set up a proxy service as Glitch doesn't allow direct Tor connections.

## Security Considerations

- The application includes safety timeouts and error handling for Tor crawling
- No actual .onion addresses are hardcoded, you'll need to replace example addresses with real ones
- Always use this application responsibly and legally

## License

This project is licensed under the MIT License - see the LICENSE file for details.
