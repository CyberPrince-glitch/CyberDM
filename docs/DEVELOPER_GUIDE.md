# CyberDM Developer Quick Reference

## Project Structure

```
CyberDM-Electron/
├── src/
│   ├── main.js           # Electron main process (download engine)
│   ├── preload.js        # Secure IPC bridge
│   ├── renderer.js       # UI logic
│   ├── index.html        # Main window HTML
│   └── styles.css        # Glassmorphism theme
├── extension/            # Chrome Extension
│   ├── manifest.json
│   ├── background.js     # Service worker
│   ├── content.js        # Page injection
│   └── popup.html/js     # Extension popup
├── native-host/          # Native messaging config
├── scripts/              # Build scripts
├── tools/                # yt-dlp binary
└── docs/                 # Documentation
```

---

## Key Classes

### SmartDownloadEngine (main.js)
Main download manager class.

```javascript
const engine = new SmartDownloadEngine();

// Start download
await engine.startDownload(url, savePath, options);

// Pause/Resume/Cancel
engine.pauseDownload(id);
engine.resumeDownload(id);
engine.cancelDownload(id);

// Get downloads
const downloads = engine.getDownloads();
```

### ChunkMonitor (main.js)
Monitors download chunk health.

```javascript
const monitor = new ChunkMonitor();

monitor.registerChunk(id, startByte, endByte);
monitor.updateProgress(id, downloaded, currentByte);
monitor.getSlowChunks();  // Returns slow chunks
monitor.getDeadChunks();  // Returns stuck chunks
```

### VideoDetector (main.js)
Video site integration.

```javascript
const detector = new VideoDetector();

// Check if video URL
const isVideo = detector.isVideoUrl(url);

// Get video info
const info = await detector.getVideoInfo(url);

// Download video
await detector.downloadVideo(url, formatId, outputPath, options);
```

### ClipboardMonitor (main.js)
Monitors clipboard for URLs.

```javascript
const monitor = new ClipboardMonitor();

monitor.start();  // Begin monitoring
monitor.stop();   // Stop monitoring
monitor.clearPending();  // Clear detected URL
```

### FileConflictManager (main.js)
Handles file existence conflicts.

```javascript
const manager = new FileConflictManager();

const result = await manager.resolveConflict(filePath, settings);
// Returns: { action: 'proceed'|'skip'|'ask'|'resume', filePath, ... }
```

---

## IPC Channels

### Main → Renderer

| Channel | Data | Description |
|---------|------|-------------|
| `download-progress` | `{ id, progress, downloaded, total, speed }` | Progress update |
| `download-complete` | `{ id, path }` | Download finished |
| `download-error` | `{ id, error }` | Download failed |
| `download-status` | `{ id, status, message }` | Status update |
| `clipboard-url-detected` | `{ url, type, filename }` | URL from clipboard |

### Renderer → Main

| Channel | Arguments | Returns |
|---------|-----------|---------|
| `download:start` | `{ url, savePath, options }` | `{ success, download }` |
| `download:pause` | `id` | `{ success }` |
| `download:resume` | `id` | `{ success }` |
| `download:cancel` | `id` | `{ success }` |
| `download:delete` | `id` | `{ success }` |
| `download:get-all` | `status` | Downloads array |
| `settings:get` | - | Settings object |
| `settings:save` | `settings` | `{ success }` |

---

## Configuration Constants

### Smart Chunk Config (main.js)

```javascript
const SMART_CHUNK_CONFIG = {
    MIN_CHUNK_SIZE: 512 * 1024,      // 512 KB
    MAX_THREADS: 32,                  // Max concurrent
    DEFAULT_THREADS: 8,               // Default threads
    SLOW_THRESHOLD: 20 * 1024,        // 20 KB/s = slow
    DEAD_THRESHOLD: 15000,            // 15 sec = dead
    SPLIT_COOLDOWN: 5000,             // 5 sec between splits
    SPEED_SAMPLE_SIZE: 10,            // Speed history size
    MAX_SPLIT_DEPTH: 3,               // Max split levels
    CONNECTION_TIMEOUT: 30000,        // 30 sec timeout
    MONITOR_INTERVAL: 500             // Check every 500ms
};
```

### Clipboard Config (main.js)

```javascript
const CLIPBOARD_CONFIG = {
    CHECK_INTERVAL: 500,      // Check every 500ms
    COOLDOWN: 3000,           // 3 sec between popups
    POPUP_DELAY: 500,         // 500ms delay
    MAX_HISTORY: 100          // Remember 100 URLs
};
```

---

## Common Tasks

### Add New Download

```javascript
// In renderer
const result = await cyberDM.startDownload(url, savePath, {
    filename: 'optional-name.zip',
    threads: 16
});

if (result.success) {
    // Download started
} else if (result.conflict) {
    // Show conflict dialog
}
```

### Handle Progress Updates

```javascript
// In renderer
cyberDM.onProgress((data) => {
    const { id, progress, speed } = data;
    updateUI(id, progress, speed);
});
```

### Check File Conflict

```javascript
// In main process
const result = await fileConflictManager.resolveConflict(filePath, {
    fileConflictMode: 'ask'  // or 'rename', 'overwrite', 'skip'
});

switch (result.action) {
    case 'proceed':
        // Continue with result.filePath
        break;
    case 'skip':
        // Skip download
        break;
    case 'ask':
        // Show conflict dialog to user
        break;
    case 'resume':
        // Resume partial download
        break;
}
```

---

## Debugging Tips

### Enable Debug Logging

Add to main.js:
```javascript
console.log('[DEBUG]', message, data);
```

### Check Download State

```javascript
// In DevTools console (renderer)
await cyberDM.getDownloads();

// In main process
const downloads = store.get('downloads');
console.log(downloads);
```

### Test Video Detection

```javascript
// In main process
const detector = new VideoDetector();
const isVideo = detector.isVideoUrl('https://youtube.com/watch?v=...');
const info = await detector.getVideoInfo(url);
```

---

## Build Commands

```bash
# Development
npm start

# Build installer
npm run build

# Build portable
npm run build:portable

# Build unpacked
npm run pack
```

---

## Testing Checklist

### Download Tests
- [ ] Regular HTTP download
- [ ] HTTPS download
- [ ] Resume partial download
- [ ] Cancel download
- [ ] File conflict (ask mode)
- [ ] File conflict (rename mode)
- [ ] Multi-threaded download

### Video Tests
- [ ] YouTube video
- [ ] Facebook video
- [ ] Quality selection
- [ ] Audio-only download

### Extension Tests
- [ ] Install extension
- [ ] Context menu download
- [ ] Video detection
- [ ] Clipboard monitoring

### UI Tests
- [ ] Category filtering
- [ ] Settings save/load
- [ ] Speed graph
- [ ] Notifications
- [ ] System tray

---

## Code Style Guidelines

### Naming Conventions
- Classes: `PascalCase` (e.g., `SmartDownloadEngine`)
- Methods: `camelCase` (e.g., `startDownload`)
- Constants: `UPPER_SNAKE_CASE` (e.g., `MAX_THREADS`)
- Private: `_prefix` (e.g., `_internalMethod`)

### Error Handling
```javascript
try {
    const result = await operation();
    return { success: true, data: result };
} catch (error) {
    console.error('Operation failed:', error);
    return { success: false, error: error.message };
}
```

### Async Patterns
```javascript
// Prefer async/await
async function doSomething() {
    try {
        const result = await asyncOperation();
        return result;
    } catch (error) {
        handleError(error);
    }
}
```

---

## Resources

- [Electron Docs](https://www.electronjs.org/docs)
- [yt-dlp Docs](https://github.com/yt-dlp/yt-dlp)
- [Chrome Extension Docs](https://developer.chrome.com/docs/extensions/)

---

**Last Updated**: 2026-03-19
