const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to renderer
contextBridge.exposeInMainWorld('cyberDM', {
    // Download operations
    startDownload: (url, savePath, options) =>
        ipcRenderer.invoke('download:start', { url, savePath, options }),

    pauseDownload: (id) =>
        ipcRenderer.invoke('download:pause', id),

    resumeDownload: (id) =>
        ipcRenderer.invoke('download:resume', id),

    cancelDownload: (id) =>
        ipcRenderer.invoke('download:cancel', id),

    deleteDownload: (id) =>
        ipcRenderer.invoke('download:delete', id),

    getDownloads: (status) =>
        ipcRenderer.invoke('download:get-all', status),

    getDownload: (id) =>
        ipcRenderer.invoke('download:get', id),

    clearHistory: () =>
        ipcRenderer.invoke('download:clear-history'),

    startQueue: () => ipcRenderer.invoke('queue:start'),
    stopQueue: () => ipcRenderer.invoke('queue:stop'),
    getQueue: () => ipcRenderer.invoke('queue:get'),
    reorderQueue: (ids) => ipcRenderer.invoke('queue:reorder', ids),

    // File dialogs
    showSaveDialog: (defaultName) =>
        ipcRenderer.invoke('dialog:save-file', defaultName),

    showFolderDialog: () =>
        ipcRenderer.invoke('dialog:select-folder'),

    // Settings
    getSettings: () =>
        ipcRenderer.invoke('settings:get'),

    saveSettings: (settings) =>
        ipcRenderer.invoke('settings:save', settings),

    getBandwidthProfiles: () =>
        ipcRenderer.invoke('bandwidth:get-profiles'),

    saveBandwidthProfiles: (profiles) =>
        ipcRenderer.invoke('bandwidth:set-profiles', profiles),

    // URL operations
    checkUrlStatus: (url) =>
        ipcRenderer.invoke('url:check-status', url),

    // Window controls
    minimizeWindow: () =>
        ipcRenderer.send('window:minimize'),

    maximizeWindow: () =>
        ipcRenderer.send('window:maximize'),

    closeWindow: () =>
        ipcRenderer.send('window:close'),

    // App
    quit: () =>
        ipcRenderer.send('app:quit'),

    finishOnboarding: () =>
        ipcRenderer.send('app:finish-onboarding'),

    openFile: (id) =>
        ipcRenderer.invoke('download:open-file', id),

    // YouTube yt-dlp
    getYouTubeFormats: (url) =>
        ipcRenderer.invoke('youtube:get-formats', url),

    downloadYouTube: (url, formatId, filename) =>
        ipcRenderer.invoke('youtube:download', url, formatId, filename),

    onDownloadStarted: (callback) =>
        ipcRenderer.on('download-started', (event, data) => callback(data)),


    showFolderDialog: () =>
        ipcRenderer.invoke('dialog:select-folder'),

    openDownloadFolder: () =>
        ipcRenderer.invoke('app:open-download-folder'),

    openExtensionFolder: () =>
        ipcRenderer.invoke('app:open-extension-folder'),

    // Clipboard operations
    startClipboardMonitor: () =>
        ipcRenderer.invoke('clipboard:start-monitor'),

    stopClipboardMonitor: () =>
        ipcRenderer.invoke('clipboard:stop-monitor'),

    getUrlInfo: (url) =>
        ipcRenderer.invoke('clipboard:get-url-info', url),

    clearClipboardPending: () =>
        ipcRenderer.invoke('clipboard:clear-pending'),

    // File conflict operations
    checkFileConflict: (filePath) =>
        ipcRenderer.invoke('file:check-conflict', filePath),

    generateUniqueFilename: (filePath) =>
        ipcRenderer.invoke('file:generate-name', filePath),

    getFileStats: (filePath) =>
        ipcRenderer.invoke('file:get-stats', filePath),

    // File operations
    showInFolder: (downloadId) =>
        ipcRenderer.invoke('download:show-in-folder', downloadId),

    // Video detection operations
    isVideoUrl: (url) =>
        ipcRenderer.invoke('video:is-video-url', url),

    getVideoInfo: (url, auth = null) =>
        ipcRenderer.invoke('video:get-info', { url, ...auth }),

    downloadVideo: (url, formatId, savePath, filename, audioOnly, hasAudio, height, auth = null, title = null, container = null) =>
        ipcRenderer.invoke('video:download', { url, formatId, savePath, filename, audioOnly, hasAudio, height, title, container, ...auth }),

    openExternal: (url) => 
        ipcRenderer.invoke('app:open-external', url),

    // Events
    onProgress: (callback) => {
        ipcRenderer.on('download-progress', (event, data) => callback(data));
    },

    onComplete: (callback) => {
        ipcRenderer.on('download-complete', (event, data) => callback(data));
    },

    onError: (callback) => {
        ipcRenderer.on('download-error', (event, data) => callback(data));
    },

    onStatus: (callback) => {
        ipcRenderer.on('download-status', (event, data) => callback(data));
    },

    onRefreshUrlRequest: (callback) => {
        ipcRenderer.on('refresh-url-request', (event, data) => callback(data));
    },

    onClipboardUrl: (callback) => {
        ipcRenderer.on('clipboard-url-detected', (event, data) => callback(data));
    },

    onShowAddDialog: (callback) => {
        ipcRenderer.on('show-add-dialog', (_event, data) => callback(data));
    },

    checkUpdates: () => ipcRenderer.invoke('update:check'),

    // Maya AI
    setGeminiKey: (key) => ipcRenderer.invoke('ai:set-key', key),
    getGeminiKey: () => ipcRenderer.invoke('ai:get-key'),
    chatWithMaya: (message) => ipcRenderer.invoke('ai:chat', message),
    clearMayaHistory: () => ipcRenderer.invoke('ai:clear-history'),
    getMayaGreeting: () => ipcRenderer.invoke('ai:get-greeting'),
    getMayaDownloadPhrase: () => ipcRenderer.invoke('ai:get-download-phrase'),
    searchMovies: (query) => ipcRenderer.invoke('ai:search-movies', query),
    getTTSConfig: () => ipcRenderer.invoke('ai:get-tts-config'),

    // Torrent
    addTorrent: (magnetOrUrl) => ipcRenderer.invoke('torrent:add', magnetOrUrl),
    getTorrentStatus: () => ipcRenderer.invoke('torrent:get-status'),
    removeTorrent: (infoHash) => ipcRenderer.invoke('torrent:remove', infoHash),
    onTorrentProgress: (callback) => ipcRenderer.on('torrent-progress', (event, data) => callback(data)),
    onTorrentComplete: (callback) => ipcRenderer.on('torrent-complete', (event, data) => callback(data)),

    // Stream capture
    listStreamQualities: (url) => ipcRenderer.invoke('stream:list-qualities', url),
    grabStream: (options) => ipcRenderer.invoke('stream:grab', options),
    cancelStream: (id) => ipcRenderer.invoke('stream:cancel', id),

    // Remove listeners
    removeAllListeners: (channel) => {
        ipcRenderer.removeAllListeners(channel);
    }
});
