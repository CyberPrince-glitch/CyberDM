# CyberDM API Documentation

Complete API reference for CyberDM's IPC communication between main and renderer processes.

---

## 📡 IPC Channels Overview

CyberDM uses Electron's IPC (Inter-Process Communication) for communication between the main process (Node.js) and renderer process (Chromium).

---

## Renderer → Main (Invoke/Send)

### Download Operations

#### `download:start`
Start a new download.

**Parameters:**
```javascript
{
  url: string,          // Download URL
  savePath: string,     // Target directory (optional)
  options: {
    filename: string,   // Custom filename (optional)
    threads: number     // Number of threads (default: 8)
  }
}
```

**Returns:**
```javascript
{
  success: boolean,
  download: object,     // Download metadata
  error: string,        // Error message if failed
  conflict: object      // Conflict info if file exists
}
```

---

#### `download:pause`
Pause an active download.

**Parameters:** `downloadId` (string)

**Returns:** `{ success: boolean }`

---

#### `download:resume`
Resume a paused download.

**Parameters:** `downloadId` (string)

**Returns:** `{ success: boolean }`

---

#### `download:cancel`
Cancel a download.

**Parameters:** `downloadId` (string)

**Returns:** `{ success: boolean }`

---

#### `download:delete`
Delete a download from history.

**Parameters:** `downloadId` (string)

**Returns:** `{ success: boolean }`

---

#### `download:get-all`
Get all downloads.

**Parameters:** `status` (string, optional) - Filter by status

**Returns:** Array of download objects

---

#### `download:get`
Get a specific download.

**Parameters:** `downloadId` (string)

**Returns:** Download object or null

---

#### `download:clear-history`
Clear completed/failed downloads from history.

**Returns:** `{ success: boolean }`

---

#### `download:show-in-folder`
Open file location in Explorer.

**Parameters:** `downloadId` (string)

**Returns:**
```javascript
{
  success: boolean,
  fileNotFound: boolean,  // True if file moved/deleted
  error: string
}
```

---

### Video Operations

#### `video:is-video-url`
Check if URL is from a video site.

**Parameters:** `url` (string)

**Returns:** `{ isVideo: boolean }`

---

#### `video:get-info`
Get video information and available formats.

**Parameters:** `url` (string)

**Returns:**
```javascript
{
  success: boolean,
  title: string,
  thumbnail: string,
  duration: number,
  uploader: string,
  description: string,
  formats: [
    {
      formatId: string,
      label: string,
      quality: string,
      height: number,
      isAudio: boolean,
      isBest: boolean
    }
  ],
  error: string
}
```

---

#### `video:download`
Download a video with specific format.

**Parameters:**
```javascript
{
  url: string,
  formatId: string,
  savePath: string,
  filename: string,
  audioOnly: boolean
}
```

**Returns:**
```javascript
{
  success: boolean,
  path: string,
  error: string
}
```

---

### Settings Operations

#### `settings:get`
Get current settings.

**Returns:** Settings object

---

#### `settings:save`
Save settings.

**Parameters:** Settings object

**Returns:** `{ success: boolean }`

---

### Dialog Operations

#### `dialog:select-folder`
Show folder selection dialog.

**Returns:** `folderPath` (string) or `undefined`

---

### Clipboard Operations

#### `clipboard:start-monitor`
Start monitoring clipboard for URLs.

**Returns:** `{ success: boolean }`

---

#### `clipboard:stop-monitor`
Stop monitoring clipboard.

**Returns:** `{ success: boolean }`

---

#### `clipboard:get-url-info`
Get information about a URL.

**Parameters:** `url` (string)

**Returns:**
```javascript
{
  success: boolean,
  size: number,
  sizeFormatted: string,
  type: string,
  supportsResume: boolean
}
```

---

#### `clipboard:clear-pending`
Clear pending clipboard URL.

**Returns:** `{ success: boolean }`

---

### File Operations

#### `file:check-conflict`
Check if file exists and get conflict resolution.

**Parameters:** `filePath` (string)

**Returns:**
```javascript
{
  action: 'proceed' | 'resume' | 'skip' | 'ask',
  filePath: string,
  renamed: boolean,
  overwrite: boolean,
  existingSize: number,
  existingDate: Date,
  suggestedName: string
}
```

---

#### `file:generate-name`
Generate unique filename if file exists.

**Parameters:** `filePath` (string)

**Returns:** `newFilePath` (string)

---

#### `file:get-stats`
Get file statistics.

**Parameters:** `filePath` (string)

**Returns:**
```javascript
{
  size: number,
  modified: Date,
  created: Date
}
```

---

### App Operations

#### `app:open-download-folder`
Open the default download folder.

**Returns:**
```javascript
{
  success: boolean,
  error: string
}
```

---

#### `app:open-extension-folder`
Open the Chrome extension folder.

**Returns:**
```javascript
{
  success: boolean,
  error: string
}
```

---

### Window Operations

#### `window:minimize`
Minimize window (or hide to tray if enabled).

#### `window:maximize`
Toggle maximize/restore window.

#### `window:close`
Close window (may minimize to tray).

#### `app:quit`
Quit the application.

---

## Main → Renderer (Events)

### `download-progress`
Sent during active downloads.

**Data:**
```javascript
{
  id: string,
  progress: number,        // 0-100
  downloaded: number,      // bytes
  total: number,           // bytes
  speed: number,           // bytes/sec
  threads: number,
  chunks: [
    {
      id: string,
      index: number,
      progress: number,
      speed: number
    }
  ]
}
```

---

### `download-complete`
Sent when download finishes.

**Data:**
```javascript
{
  id: string,
  path: string
}
```

---

### `download-error`
Sent when download fails.

**Data:**
```javascript
{
  id: string,
  error: string
}
```

---

### `download-status`
Sent when download status changes.

**Data:**
```javascript
{
  id: string,
  status: string,
  message: string
}
```

---

### `clipboard-url-detected`
Sent when valid URL found in clipboard.

**Data:**
```javascript
{
  url: string,
  type: string,
  filename: string,
  domain: string,
  isVideo: boolean
}
```

---

### `refresh-url-request`
Sent when URL needs refreshing (for video sites).

**Data:**
```javascript
{
  requestId: string,
  oldUrl: string,
  pageUrl: string,
  videoId: string
}
```

---

### `show-add-dialog`
Sent to show the add download dialog (e.g., from extension).

---

## 🔄 Usage Examples

### Start a Download
```javascript
const result = await cyberDM.startDownload(
  'https://example.com/file.zip',
  'C:\\Downloads',
  { filename: 'myfile.zip', threads: 16 }
);

if (result.success) {
  console.log('Download started:', result.download.id);
} else if (result.conflict) {
  console.log('File exists:', result.conflict.suggestedName);
}
```

---

### Get Video Info
```javascript
const info = await cyberDM.getVideoInfo('https://youtube.com/watch?v=...');

if (info.success) {
  console.log('Title:', info.title);
  console.log('Formats:', info.formats);
}
```

---

### Listen for Progress
```javascript
cyberDM.onProgress((data) => {
  console.log(`Progress: ${data.progress}%`);
  console.log(`Speed: ${data.speed} bytes/sec`);
});
```

---

### Handle Clipboard URL
```javascript
cyberDM.onClipboardUrl((data) => {
  console.log('URL detected:', data.url);
  console.log('Type:', data.type);
  // Show popup to user
});
```

---

## 🔒 Security Notes

- All IPC channels are exposed through `preload.js` using `contextBridge`
- Renderer cannot directly access Node.js APIs
- File paths are validated before operations
- URL validation is performed on all downloads

---

## 📊 Data Types

### Download Object
```javascript
{
  id: string,
  url: string,
  originalUrl: string,
  filename: string,
  savePath: string,
  status: 'downloading' | 'paused' | 'completed' | 'failed' | 'queued',
  progress: number,
  downloadedBytes: number,
  totalBytes: number,
  speed: number,
  category: string,
  chunks: Array,
  startTime: Date,
  errorMessage: string
}
```

### Settings Object
```javascript
{
  downloadPath: string,
  maxConcurrent: number,
  chunkCount: number,
  speedLimit: number,
  connectionTimeout: number,
  maxRetries: number,
  retryDelay: number,
  userAgent: string,
  fileConflictMode: 'ask' | 'rename' | 'overwrite' | 'skip',
  minimizeToTray: boolean,
  startWithWindows: boolean,
  autoResume: boolean,
  showNotification: boolean
}
```

---

## 🛠️ Error Handling

All IPC calls should include error handling:

```javascript
try {
  const result = await cyberDM.someOperation();
  if (result.success) {
    // Handle success
  } else {
    // Handle API error
    console.error(result.error);
  }
} catch (error) {
  // Handle IPC error
  console.error('IPC Error:', error.message);
}
```

---

**Last Updated**: 2026-03-19
