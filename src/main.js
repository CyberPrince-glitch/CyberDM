const nativeMessagingHostMode = process.argv.includes('--native-messaging-host');
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell, clipboard, Notification, safeStorage } = require('electron');
if (nativeMessagingHostMode) {
    // Chrome's native-messaging protocol uses stdout for framed JSON only.
    const formatLog = require('util').format;
    const writeNativeHostLog = (...args) => process.stderr.write(`${formatLog(...args)}\n`);
    console.log = writeNativeHostLog;
    console.info = writeNativeHostLog;
    console.warn = writeNativeHostLog;
    console.error = writeNativeHostLog;
    console.debug = writeNativeHostLog;
    process.stdout.write = function (chunk, encoding, callback) {
        writeNativeHostLog(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        const done = typeof encoding === 'function' ? encoding : callback;
        if (typeof done === 'function') done();
        return true;
    };
}
// Take the desktop instance lock before loading the download engine and its
// larger dependency tree. Browser handoffs can arrive in a burst; secondary
// Electron processes should exit before doing that work.
app.setName('CyberDM');
app.setAppUserModelId('com.cyberdm.app');
const hasSingleInstanceLock = nativeMessagingHostMode ? false : app.requestSingleInstanceLock();
if (!nativeMessagingHostMode && !hasSingleInstanceLock) {
    app.quit();
    process.exit(0);
}
if (!nativeMessagingHostMode) {
    app.on('second-instance', (_event, commandLine) => {
        const extensionArgument = extensionRequestArgument(commandLine);
        if (extensionArgument) {
            handleExtensionDownloadArgument(extensionArgument)
                .then(result => {
                    writeExtensionRequestAck(extensionRequestId(extensionArgument), result);
                    if (!result.success) log('Extension handoff rejected: ' + result.error);
                })
                .catch(error => {
                    writeExtensionRequestAck(extensionRequestId(extensionArgument), { success: false, error: error.message });
                    log('Extension handoff failed: ' + error.message);
                });
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });
}
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { Transform } = require('stream');
const { URL } = require('url');
const Store = require('electron-store');
const { v4: uuidv4 } = require('uuid');
const { splitChunk } = require('./chunk-splitter');
const { findDuplicateDownload } = require('./download-dedupe');
const { recoverIncompleteDownloads } = require('./recovery-manager');
const { verifyChecksum } = require('./checksum');
const { spawn, exec } = require('child_process');
const mirrorManager = require('./mirror-manager');
const { init: proxyInit, buildProxyUrl, applyProxy } = require('./proxy-manager');
const { init: bwSchedInit, start: bwSchedStart, getProfiles: getBandwidthProfiles, setProfiles: setBandwidthProfiles } = require('./bandwidth-scheduler');

// File logging setup
const logFile = path.join(app.getPath('userData'), 'debug.log');
let pendingLogWrites = Promise.resolve();
function log(msg) {
    const time = new Date().toISOString();
    const line = `[${time}] ${msg}\n`;
    pendingLogWrites = pendingLogWrites
        .then(() => fs.promises.appendFile(logFile, line))
        .catch(() => {});
    // Native messaging reserves stdout for length-prefixed JSON responses.
    if (nativeMessagingHostMode) console.error(msg);
    else console.log(msg);
}

log('--- APP STARTING ---');

// Enable GPU acceleration (was disabled for debugging)
// app.disableHardwareAcceleration();

// Global references
let mainWindow = null;
let tray = null;
let downloadEngine = null;
let clipboardMonitor = null;
let videoDetector = null;
let torrentClient = null;
const activeTorrentJobs = new Map();
const torrentJobsByDownload = new Map();
const decryptedAuthHeaders = new Map();
const inFlightExtensionRequests = new Map();

// Centralised constants
const {
    APP_DATA,
    DOWNLOADS_PATH,
    TEMP_PATH,
    CHUNKS_PATH
} = require('./constants');

// Ensure required directories exist
[TEMP_PATH, CHUNKS_PATH].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});


// ============== UPDATE CHECKER ==============
const cdmConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const MAYA_MODEL = cdmConfig.maya?.model || 'gemini-3.8-flash';

class UpdateChecker {
    async checkForUpdates() {
        try {
            const result = await this.fetchVersionInfo();
            const currentVersion = require('../package.json').version;
            return {
                currentVersion, latestVersion: result.latest_version,
                minSupported: result.min_supported, forceUpdate: result.force_update,
                downloadUrl: result.download_url,
                needsUpdate: this._cmpVer(currentVersion, result.latest_version) < 0
            };
        } catch (err) { return { needsUpdate: false, error: err.message }; }
    }

    async fetchVersionInfo() {
        let lastError;
        for (const baseUrl of [cdmConfig.api_primary, cdmConfig.api_backup].filter(Boolean)) {
            try {
                return await new Promise((resolve, reject) => {
                    const postData = '{}';
                    const parsedUrl = new URL(baseUrl + 'version.php');
                    const mod = parsedUrl.protocol === 'https:' ? https : http;
                    const req = mod.request({
                        hostname: parsedUrl.hostname,
                        port: parsedUrl.port,
                        path: parsedUrl.pathname + parsedUrl.search,
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
                        timeout: 10000
                    }, response => {
                        let body = '';
                        response.on('data', chunk => body += chunk);
                        response.on('end', () => {
                            if (response.statusCode < 200 || response.statusCode >= 300) {
                                reject(new Error(`Update service returned HTTP ${response.statusCode}`));
                                return;
                            }
                            try { resolve(JSON.parse(body)); }
                            catch (_) { reject(new Error('Invalid update service response')); }
                        });
                    });
                    req.on('error', reject);
                    req.on('timeout', () => { req.destroy(); reject(new Error('Update check timed out')); });
                    req.end(postData);
                });
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError || new Error('No update service is configured');
    }

    _cmpVer(a, b) {
        const pa = (a || '0').replace(/[^0-9.]/g, '').split('.').map(Number);
        const pb = (b || '0').replace(/[^0-9.]/g, '').split('.').map(Number);
        for (let i = 0; i < 3; i++) { if ((pa[i]||0) < (pb[i]||0)) return -1; if ((pa[i]||0) > (pb[i]||0)) return 1; }
        return 0;
    }

}

let updateChecker = null;


// ============== CLIPBOARD MONITOR SYSTEM ==============
const CLIPBOARD_CONFIG = {
    CHECK_INTERVAL: 500,          // Check clipboard every 500ms
    COOLDOWN: 3000,               // 3 second cooldown between popups
    POPUP_DELAY: 500,             // 500ms delay before showing popup
    MAX_HISTORY: 100,             // Remember last 100 URLs
    VALID_EXTENSIONS: [
        '.zip', '.rar', '.7z', '.tar', '.gz',
        '.mp4', '.mkv', '.avi', '.mov', '.webm', '.m3u8', '.mpd',
        '.mp3', '.wav', '.flac', '.aac', '.m4a',
        '.exe', '.msi', '.dmg', '.deb', '.rpm',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
        '.iso', '.img', '.bin'
    ],
    VIDEO_DOMAINS: [
        'youtube.com', 'youtu.be', 'facebook.com', 'vimeo.com',
        'dailymotion.com', 'twitch.tv', 'twitter.com', 'x.com',
        'instagram.com', 'tiktok.com', 'reddit.com'
    ]
};

class ClipboardMonitor {
    constructor() {
        this.lastClipboard = '';
        this.urlHistory = new Set();
        this.lastPopupTime = 0;
        this.isMonitoring = false;
        this.monitorInterval = null;
        this.pendingUrl = null;
    }

    start() {
        if (this.isMonitoring) return;

        this.isMonitoring = true;
        this.lastClipboard = clipboard.readText() || '';

        this.monitorInterval = setInterval(() => {
            this.checkClipboard();
        }, CLIPBOARD_CONFIG.CHECK_INTERVAL);

        console.log('Clipboard monitor started');
    }

    stop() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
        this.isMonitoring = false;
        console.log('Clipboard monitor stopped');
    }

    checkClipboard() {
        try {
            const currentClipboard = clipboard.readText() || '';

            // Skip if same as last
            if (currentClipboard === this.lastClipboard) return;

            this.lastClipboard = currentClipboard;

            // Validate URL
            const urlInfo = this.validateUrl(currentClipboard);

            if (urlInfo.valid) {
                // Check cooldown
                const now = Date.now();
                if (now - this.lastPopupTime < CLIPBOARD_CONFIG.COOLDOWN) return;

                // Check if already processed
                if (this.urlHistory.has(urlInfo.url)) return;

                // Add to history
                this.urlHistory.add(urlInfo.url);
                if (this.urlHistory.size > CLIPBOARD_CONFIG.MAX_HISTORY) {
                    // Remove oldest entry
                    const first = this.urlHistory.values().next().value;
                    this.urlHistory.delete(first);
                }

                // Check if already downloading
                const downloads = store.get('downloads') || [];
                const isDownloading = downloads.some(d =>
                    d.url === urlInfo.url || d.originalUrl === urlInfo.url
                );
                if (isDownloading) return;

                // Valid URL found - notify renderer
                this.pendingUrl = urlInfo;
                this.lastPopupTime = now;

                // Send to renderer after small delay
                setTimeout(() => {
                    if (mainWindow && !mainWindow.isDestroyed() && this.pendingUrl) {
                        mainWindow.webContents.send('clipboard-url-detected', {
                            url: urlInfo.url,
                            type: urlInfo.type,
                            filename: urlInfo.filename,
                            domain: urlInfo.domain,
                            isVideo: urlInfo.isVideo
                        });
                    }
                }, CLIPBOARD_CONFIG.POPUP_DELAY);
            }
        } catch (error) {
            // Ignore clipboard errors
        }
    }

    validateUrl(text) {
        const trimmed = text.trim();

        // Must be a URL
        if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
            return { valid: false };
        }

        try {
            const urlObj = new URL(trimmed);
            const hostname = urlObj.hostname.toLowerCase();
            const pathname = urlObj.pathname.toLowerCase();

            // Check for direct file links
            const hasValidExtension = CLIPBOARD_CONFIG.VALID_EXTENSIONS.some(ext =>
                pathname.endsWith(ext) || trimmed.toLowerCase().includes(ext)
            );

            // Check for video domains
            const isVideoDomain = CLIPBOARD_CONFIG.VIDEO_DOMAINS.some(domain =>
                hostname.includes(domain)
            );

            // Determine type
            let type = 'general';
            let filename = 'download';
            let isVideo = false;

            if (hasValidExtension) {
                // Extract filename from URL
                const urlFilename = pathname.split('/').pop() || 'download';
                filename = decodeURIComponent(urlFilename.split('?')[0]);

                // Determine type
                if (['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m3u8', '.mpd'].some(ext => pathname.includes(ext))) {
                    type = 'video';
                    isVideo = true;
                } else if (['.mp3', '.wav', '.flac', '.aac', '.m4a'].some(ext => pathname.includes(ext))) {
                    type = 'audio';
                } else if (['.zip', '.rar', '.7z', '.tar', '.gz'].some(ext => pathname.includes(ext))) {
                    type = 'archive';
                } else if (['.exe', '.msi', '.dmg', '.deb', '.rpm'].some(ext => pathname.includes(ext))) {
                    type = 'software';
                } else if (['.pdf', '.doc', '.docx', '.xls', '.xlsx'].some(ext => pathname.includes(ext))) {
                    type = 'document';
                }
            } else if (isVideoDomain) {
                type = 'video-page';
                isVideo = true;
                filename = `video_${Date.now()}`;
            } else {
                // General URL - might still be downloadable
                filename = pathname.split('/').pop() || 'download';
            }

            return {
                valid: true,
                url: trimmed,
                type,
                filename,
                domain: hostname,
                isVideo
            };
        } catch (error) {
            return { valid: false };
        }
    }

    // Clear pending URL (after user action)
    clearPending() {
        this.pendingUrl = null;
    }

    // Get file info for preview
    async getUrlInfo(url) {
        return new Promise((resolve) => {
            try {
                const urlObj = new URL(url);
                const protocol = urlObj.protocol === 'https:' ? https : http;

                const req = protocol.request({
                    method: 'HEAD',
                    hostname: urlObj.hostname,
                    port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                    path: urlObj.pathname + urlObj.search,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                }, (res) => {
                    const contentLength = parseInt(res.headers['content-length'] || '0');
                    const contentType = res.headers['content-type'] || '';
                    const contentDisposition = res.headers['content-disposition'] || '';

                    let filename = 'download';
                    if (contentDisposition) {
                        const match = contentDisposition.match(/filename[*]?=['"]?([^'";\n]+)['"]?/i);
                        if (match) filename = decodeURIComponent(match[1]);
                    } else {
                        filename = urlObj.pathname.split('/').pop() || 'download';
                    }

                    resolve({
                        success: true,
                        filename: decodeURIComponent(filename.split('?')[0]),
                        size: contentLength,
                        sizeFormatted: this.formatSize(contentLength),
                        contentType,
                        supportsResume: res.headers['accept-ranges'] === 'bytes'
                    });
                });

                req.on('error', () => {
                    resolve({ success: false });
                });

                req.setTimeout(10000, () => {
                    req.destroy();
                    resolve({ success: false });
                });

                req.end();
            } catch (error) {
                resolve({ success: false });
            }
        });
    }

    formatSize(bytes) {
        if (!bytes || bytes <= 0 || !isFinite(bytes)) return 'Unknown size';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}

// ============== VIDEO DETECTOR ==============
// Detects video qualities from YouTube, Facebook, and other video sites
class VideoDetector {
    constructor() {
        this.ytdlpPath = this.findYtDlp();
        this.ffmpegPath = this.findFFmpeg();
        console.log('yt-dlp path:', this.ytdlpPath);
    }

    findYtDlp() {
        // Priority order for finding yt-dlp
        const locations = [
            // Bundled with app (production)
            path.join(process.resourcesPath || '', 'tools', 'yt-dlp.exe'),
            path.join(process.resourcesPath || '', 'tools', 'yt-dlp'),
            // Development mode
            path.join(__dirname, '..', 'tools', 'yt-dlp.exe'),
            path.join(__dirname, '..', 'tools', 'yt-dlp'),
            // User data directory
            path.join(app.getPath('userData'), 'tools', 'yt-dlp.exe'),
            path.join(app.getPath('userData'), 'tools', 'yt-dlp'),
            // System PATH
            'yt-dlp',
            'yt-dlp.exe'
        ];

        for (const loc of locations) {
            try {
                if (fs.existsSync(loc)) {
                    console.log('Found yt-dlp at:', loc);
                    return loc;
                }
            } catch {}
        }

        // Try to find in PATH on Windows
        try {
            const result = exec('where yt-dlp', { encoding: 'utf8' });
            if (result.stdout && result.stdout.trim()) {
                const foundPath = result.stdout.trim().split('\n')[0];
                console.log('Found yt-dlp in PATH:', foundPath);
                return foundPath;
            }
        } catch {}

        console.log('Cyber Engine not found, using system PATH');
        return 'yt-dlp'; // Fall back to system PATH
    }

    findFFmpeg() {
        const locations = [
            // Bundled with app (production)
            path.join(process.resourcesPath || '', 'tools', 'ffmpeg.exe'),
            path.join(process.resourcesPath || '', 'tools', 'ffmpeg'),
            // Development mode
            path.join(__dirname, '..', 'tools', 'ffmpeg.exe'),
            path.join(__dirname, '..', 'tools', 'ffmpeg'),
            // User data directory
            path.join(app.getPath('userData'), 'tools', 'ffmpeg.exe'),
            // System PATH
            'ffmpeg',
            'ffmpeg.exe'
        ];

        for (const loc of locations) {
            try {
                if (fs.existsSync(loc)) {
                    return loc;
                }
            } catch {}
        }

        return 'ffmpeg';
    }

    isVideoUrl(url) {
        try {
            const parsedUrl = new URL(url);
            if (!['http:', 'https:'].includes(parsedUrl.protocol)) return false;
            const hostname = parsedUrl.hostname.toLowerCase();
            if (/\.(?:m3u8|mpd)$/i.test(parsedUrl.pathname)) return true;
            const videoSites = [
                'youtube.com', 'youtu.be', 'facebook.com', 'vimeo.com',
                'dailymotion.com', 'twitch.tv', 'twitter.com', 'x.com',
                'instagram.com', 'tiktok.com', 'reddit.com', 'rumble.com',
                'bitchute.com', 'odysee.com', 'rumble.com'
            ];
            return videoSites.some(site => hostname.includes(site));
        } catch {
            return false;
        }
    }

    async getVideoInfo(url, cookiesFile = null, referer = null) {
        return new Promise((resolve, reject) => {
            if (!this.ytdlpPath) {
                reject(new Error('Cyber Engine not found. Please reinstall CyberDM.'));
                return;
            }

            const args = [
                '--dump-single-json',
                '--no-download',
                '--no-playlist',
                '--no-warnings',
                '--no-progress',
                '--socket-timeout', '15',
                '--retries', '1',
                '--extractor-retries', '1'
            ];
            if (cookiesFile) args.push('--cookies', cookiesFile);
            if (referer) args.push('--referer', referer);
            args.push(url);

            let ytdlp;
            try {
                ytdlp = spawn(this.ytdlpPath, args, { windowsHide: true });
            } catch (error) {
                reject(new Error(`Failed to start the video engine: ${error.message}`));
                return;
            }
            let stdout = '';
            let stderr = '';
            let settled = false;
            const finish = (error, result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                if (error) reject(error);
                else resolve(result);
            };

            ytdlp.stdout.on('data', (data) => {
                stdout += data.toString();
                if (stdout.length > 32 * 1024 * 1024) {
                    ytdlp.kill();
                    finish(new Error('Video metadata response is too large'));
                }
            });

            ytdlp.stderr.on('data', (data) => {
                stderr = (stderr + data.toString()).slice(-12000);
            });

            ytdlp.on('close', (code) => {
                if (settled) return;
                if (code !== 0) {
                    finish(new Error(stderr.trim() || `Cyber Engine exited with code ${code}`));
                    return;
                }

                try {
                    const info = JSON.parse(stdout);
                    let formats = this.parseFormats(info);
                    
                    finish(null, {
                        success: true,
                        title: info.title || 'Unknown Title',
                        thumbnail: info.thumbnail || info.thumbnails?.[0]?.url || '',
                        duration: info.duration || 0,
                        uploader: info.uploader || info.channel || 'Unknown',
                        description: info.description?.substring(0, 200) || '',
                        formats: formats
                    });
                } catch (e) {
                    finish(new Error(`Failed to parse video info: ${e.message}`));
                }
            });

            ytdlp.on('error', (err) => {
                finish(new Error(`Failed to run the video engine: ${err.message}`));
            });

            const timeout = setTimeout(() => {
                if (settled) return;
                ytdlp.kill();
                finish(new Error('Video details took too long. Check the connection and try again.'));
            }, 45000);
        });
    }

    parseFormats(info) {
        const formats = [];
        const seenQualities = new Set();
        const preferenceScore = (format) => {
            let score = 0;
            if (format.protocol === 'https') score += 100;
            else if (String(format.protocol || '').includes('m3u8')) score -= 100;
            if (format.ext === 'mp4') score += 20;
            else if (format.ext === 'webm') score += 10;
            if (format.vcodec && /^avc1/i.test(format.vcodec)) score += 10;
            if (format.acodec && format.acodec !== 'none') score += 30;
            if (format.filesize) score += 3;
            return score;
        };

        // Get all formats
        if (info.formats && Array.isArray(info.formats)) {
            for (const fmt of info.formats) {
                const height = fmt.height;
                const vcodec = fmt.vcodec;
                const acodec = fmt.acodec;
                const ext = fmt.ext || 'mp4';
                const formatId = fmt.format_id;
                const filesize = fmt.filesize || fmt.filesize_approx || 0;
                const formatNote = fmt.format_note || '';

                // Video formats (with video)
                if (vcodec !== 'none' && height) {
                    let qualityLabel = height + 'p';
                    if (height >= 2160) qualityLabel = '4K';
                    else if (height >= 1440) qualityLabel = '1440p';
                    else if (height >= 1080) qualityLabel = '1080p';
                    else if (height >= 720) qualityLabel = '720p';
                    else if (height >= 480) qualityLabel = '480p';
                    else if (height >= 360) qualityLabel = '360p';
                    else if (height >= 240) qualityLabel = '240p';
                    else qualityLabel = height + 'p';

                    const candidate = {
                            formatId: formatId,
                            quality: qualityLabel,
                            height: height,
                            ext: ext,
                            filesize: filesize,
                            vcodec: vcodec,
                            acodec: acodec,
                            protocol: fmt.protocol,
                            type: 'video',
                            label: `${qualityLabel} (${ext})`
                        };
                    if (!seenQualities.has(qualityLabel)) {
                        seenQualities.add(qualityLabel);
                        formats.push(candidate);
                    } else {
                        const existingIndex = formats.findIndex(item => item.quality === qualityLabel && item.type === 'video');
                        if (existingIndex !== -1 && preferenceScore(candidate) > preferenceScore(formats[existingIndex])) {
                            formats[existingIndex] = candidate;
                        }
                    }
                }

                // Audio-only formats
                if (vcodec === 'none' && acodec !== 'none' && fmt.abr) {
                    const audioQuality = fmt.abr + 'kbps';
                    const audioLabel = `MP3 (${audioQuality})`;

                    if (!seenQualities.has('audio-' + fmt.abr)) {
                        seenQualities.add('audio-' + fmt.abr);
                        formats.push({
                            formatId: formatId,
                            quality: audioQuality,
                            ext: 'mp3',
                            filesize: filesize,
                            vcodec: null,
                            acodec: acodec,
                            type: 'audio',
                            label: audioLabel
                        });
                    }
                }
            }
        }

        // Sort: video formats by quality descending, then audio
        formats.sort((a, b) => {
            if (a.type === 'audio' && b.type !== 'audio') return 1;
            if (a.type !== 'audio' && b.type === 'audio') return -1;
            if (a.type === 'audio' && b.type === 'audio') {
                return (b.quality || '').localeCompare(a.quality || '');
            }
            return (b.height || 0) - (a.height || 0);
        });

        // Add combined formats (video+audio) for best experience
        const videoFormats = formats.filter(f => f.type === 'video');
        const audioFormats = formats.filter(f => f.type === 'audio');

        // Create simplified list
        const simplifiedFormats = [];

        // Add common video qualities
        const commonQualities = ['4K', '1440p', '1080p', '720p', '480p', '360p', '240p'];
        for (const q of commonQualities) {
            const found = videoFormats.find(f => f.quality === q);
            if (found) {
                simplifiedFormats.push({
                    ...found,
                    label: q,
                    isBest: q === (videoFormats[0]?.quality || '720p')
                });
            }
        }

        // Add audio-only option
        if (audioFormats.length > 0) {
            const bestAudio = audioFormats[0];
            simplifiedFormats.push({
                ...bestAudio,
                label: 'MP3 (Audio Only)',
                isAudio: true
            });
        }

        return simplifiedFormats.length > 0 ? simplifiedFormats : formats;
    }

    async downloadVideo(url, formatId, outputPath, options = {}) {
        return new Promise((resolve, reject) => {
            if (!this.ytdlpPath) {
                reject(new Error('Cyber Engine not found'));
                return;
            }

            // For YouTube, always try to merge best audio if downloading a specific video format
            let formatSpec = formatId;
            if (!options.audioOnly) {
                formatSpec = `${formatId}+bestaudio/best`;
            }

            const args = [
                '-f', formatSpec,
                '--no-playlist',
                '--no-warnings',
                '-o', outputPath,
                url
            ];

            if (this.ffmpegPath) {
                args.push('--ffmpeg-location', this.ffmpegPath);
            }

            if (options.audioOnly) {
                // Remove '-f' and formatSpec, add audio extraction args
                args.splice(0, 2, '-x', '--audio-format', 'mp3');
            }

            const ytdlp = spawn(this.ytdlpPath, args);

            ytdlp.on('close', (code) => {
                if (code === 0) {
                    resolve({ success: true, path: outputPath });
                } else {
                    reject(new Error(`Cyber Engine exited with code ${code}`));
                }
            });

            ytdlp.on('error', (err) => {
                reject(new Error(`Cyber Engine error: ${err.message}`));
            });
        });
    }
}

// ============== SMART CHUNK CONSTANTS ==============
const SMART_CHUNK_CONFIG = {
    MIN_CHUNK_SIZE: 512 * 1024,      // 512 KB minimum chunk size
    MAX_THREADS: 8,                   // Keep per-download connection use bounded
    DEFAULT_THREADS: 4,                // Stable default for typical PCs
    SLOW_THRESHOLD: 20 * 1024,        // 20 KB/s = slow chunk
    DEAD_THRESHOLD: 15000,            // 15 seconds = dead chunk
    SPLIT_COOLDOWN: 5000,             // 5 seconds between splits
    SPEED_SAMPLE_SIZE: 10,            // Keep last 10 speed samples
    MAX_SPLIT_DEPTH: 3,                // Maximum 3 split levels
    RETRY_DELAY_BASE: 1000,           // Base retry delay
    CONNECTION_TIMEOUT: 30000,        // 30 second connection timeout
    MONITOR_INTERVAL: 500             // Check chunks every 500ms
};

videoDetector = new VideoDetector();

// ============== STORAGE ==============
const store = new Store({
    name: 'cyberdm-data',
    defaults: {
        downloads: [],
        settings: {
            downloadPath: DOWNLOADS_PATH,
            maxConcurrent: 2,
            chunkCount: SMART_CHUNK_CONFIG.DEFAULT_THREADS,
            speedLimit: 0,
            enableSmartChunks: true,
            enableAutoSplit: true,
            enableDynamicThreads: true,
            startWithWindows: false,
            minimizeToTray: true,
            autoResume: true,
            showNotification: true,
            connectionTimeout: SMART_CHUNK_CONFIG.CONNECTION_TIMEOUT / 1000,
            maxRetries: 5,
            retryDelay: 5000,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            // File Conflict Settings
            fileConflictMode: 'ask', // 'ask', 'rename', 'overwrite', 'skip'
            enableClipboardMonitor: true
        }
    }
});

// ============== FILE CONFLICT MANAGER ==============
class FileConflictManager {
    constructor() {
        // File conflict modes: 'ask', 'rename', 'overwrite', 'skip'
    }

    // Check if file exists
    fileExists(filePath) {
        try {
            return fs.existsSync(filePath);
        } catch {
            return false;
        }
    }

    // Check if file is partial download (has chunk metadata)
    isPartialDownload(filePath) {
        const downloadId = path.basename(path.dirname(filePath));
        const metadataPath = path.join(CHUNKS_PATH, downloadId, 'metadata.json');
        return fs.existsSync(metadataPath);
    }

    // Generate unique filename with increment
    generateUniqueFilename(filePath) {
        if (!this.fileExists(filePath)) {
            return filePath;
        }

        const dir = path.dirname(filePath);
        const ext = path.extname(filePath);
        const baseName = path.basename(filePath, ext);

        let counter = 1;
        let newPath;

        // Try file (1).ext, file (2).ext, etc.
        while (true) {
            newPath = path.join(dir, `${baseName} (${counter})${ext}`);
            if (!this.fileExists(newPath)) {
                return newPath;
            }
            counter++;

            // Safety limit
            if (counter > 1000) {
                // Generate random suffix as fallback
                const randomSuffix = Date.now().toString(36);
                return path.join(dir, `${baseName}_${randomSuffix}${ext}`);
            }
        }
    }

    // Resolve file conflict based on settings
    async resolveConflict(filePath, settings) {
        const mode = settings.fileConflictMode || 'ask';

        // Check if file exists
        if (!this.fileExists(filePath)) {
            return { action: 'proceed', filePath };
        }

        // Check if it's a partial download (can resume)
        if (this.isPartialDownload(filePath)) {
            return { action: 'resume', filePath };
        }

        // Handle based on mode
        switch (mode) {
            case 'rename':
                const newPath = this.generateUniqueFilename(filePath);
                return { action: 'proceed', filePath: newPath, renamed: true };

            case 'overwrite':
                return { action: 'proceed', filePath, overwrite: true };

            case 'skip':
                return { action: 'skip', filePath };

            case 'ask':
            default:
                // Return conflict info for UI to handle
                const stats = this.getFileStats(filePath);
                return {
                    action: 'ask',
                    filePath,
                    existingSize: stats.size,
                    existingDate: stats.modified,
                    suggestedName: this.generateUniqueFilename(filePath)
                };
        }
    }

    // Get file stats
    getFileStats(filePath) {
        try {
            const stats = fs.statSync(filePath);
            return {
                size: stats.size,
                modified: stats.mtime,
                created: stats.birthtime
            };
        } catch {
            return { size: 0, modified: null, created: null };
        }
    }

    // Format file size
    formatSize(bytes) {
        if (!bytes || bytes <= 0 || !isFinite(bytes)) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}

const fileConflictManager = new FileConflictManager();

// ============== CHUNK MONITOR SYSTEM ==============
class ChunkMonitor {
    constructor() {
        this.chunks = new Map();
        this.speedHistory = new Map();
        this.lastActiveTime = new Map();
        this.splitHistory = new Map();
    }

    // Register a chunk for monitoring
    registerChunk(chunkId, startByte, endByte) {
        const now = Date.now();
        this.chunks.set(chunkId, {
            id: chunkId,
            startByte,
            endByte,
            currentByte: startByte,
            downloadedBytes: 0,
            speed: 0,
            avgSpeed: 0,
            status: 'pending',
            lastActiveTime: now,
            createdAt: now,
            splitCount: 0,
            retryCount: 0,
            speedHistory: []
        });
        this.speedHistory.set(chunkId, []);
    }

    // Update chunk progress
    updateProgress(chunkId, downloadedBytes, currentByte) {
        const chunk = this.chunks.get(chunkId);
        if (!chunk) return;

        const now = Date.now();
        const timeDiff = now - chunk.lastActiveTime;

        if (timeDiff > 0) {
            const bytesDiff = downloadedBytes - chunk.downloadedBytes;
            const instantSpeed = (bytesDiff / timeDiff) * 1000; // bytes per second

            // Update speed history
            chunk.speedHistory.push({ time: now, bytes: downloadedBytes, speed: instantSpeed });
            if (chunk.speedHistory.length > SMART_CHUNK_CONFIG.SPEED_SAMPLE_SIZE) {
                chunk.speedHistory.shift();
            }

            // Calculate average speed (avoid division by zero)
            const speedCount = chunk.speedHistory.length;
            chunk.avgSpeed = speedCount > 0 ? chunk.speedHistory.reduce((sum, s) => sum + s.speed, 0) / speedCount : 0;
            chunk.speed = instantSpeed;
        }

        chunk.downloadedBytes = downloadedBytes;
        chunk.currentByte = currentByte;
        chunk.lastActiveTime = now;
        chunk.status = 'downloading';
    }

    // Check if chunk is slow
    isSlow(chunkId) {
        const chunk = this.chunks.get(chunkId);
        if (!chunk || chunk.status !== 'downloading') return false;

        // Need at least 3 samples for accurate detection
        if (chunk.speedHistory.length < 3) return false;

        const avgSpeed = chunk.avgSpeed;
        const timeSinceStart = Date.now() - chunk.createdAt;

        // Only consider slow after initial startup period
        if (timeSinceStart < 5000) return false;

        return avgSpeed < SMART_CHUNK_CONFIG.SLOW_THRESHOLD && avgSpeed > 0;
    }

    // Check if chunk is dead (stuck)
    isDead(chunkId) {
        const chunk = this.chunks.get(chunkId);
        if (!chunk) return false;

        const timeSinceActive = Date.now() - chunk.lastActiveTime;
        return timeSinceActive > SMART_CHUNK_CONFIG.DEAD_THRESHOLD && chunk.status === 'downloading';
    }

    // Get chunk stats
    getStats(chunkId) {
        const chunk = this.chunks.get(chunkId);
        if (!chunk) return null;

        return {
            id: chunk.id,
            speed: chunk.speed,
            avgSpeed: chunk.avgSpeed,
            downloadedBytes: chunk.downloadedBytes,
            progress: chunk.downloadedBytes / Math.max(1, chunk.endByte - chunk.startByte + 1),
            status: chunk.status,
            isSlow: this.isSlow(chunkId),
            isDead: this.isDead(chunkId),
            splitCount: chunk.splitCount,
            retryCount: chunk.retryCount
        };
    }

    // Mark chunk as completed
    markCompleted(chunkId) {
        const chunk = this.chunks.get(chunkId);
        if (chunk) {
            chunk.status = 'completed';
            chunk.completedAt = Date.now();
        }
    }

    // Mark chunk as failed
    markFailed(chunkId, error) {
        const chunk = this.chunks.get(chunkId);
        if (chunk) {
            chunk.status = 'failed';
            chunk.error = error;
        }
    }

    // Check if can split
    canSplit(chunkId) {
        const chunk = this.chunks.get(chunkId);
        if (!chunk) return false;

        // Check split depth
        if (chunk.splitCount >= SMART_CHUNK_CONFIG.MAX_SPLIT_DEPTH) return false;

        // Check if recently split
        const lastSplit = this.splitHistory.get(chunkId) || 0;
        if (Date.now() - lastSplit < SMART_CHUNK_CONFIG.SPLIT_COOLDOWN) return false;

        // Check remaining size
        const remainingBytes = chunk.endByte - chunk.currentByte;
        if (remainingBytes < SMART_CHUNK_CONFIG.MIN_CHUNK_SIZE * 2) return false;

        return true;
    }

    // Record a split
    recordSplit(chunkId) {
        this.splitHistory.set(chunkId, Date.now());
        const chunk = this.chunks.get(chunkId);
        if (chunk) {
            chunk.splitCount++;
        }
    }

    // Get all slow chunks
    getSlowChunks() {
        const slow = [];
        for (const [id, chunk] of this.chunks) {
            if (this.isSlow(id)) {
                slow.push(this.getStats(id));
            }
        }
        return slow;
    }

    // Get all dead chunks
    getDeadChunks() {
        const dead = [];
        for (const [id, chunk] of this.chunks) {
            if (this.isDead(id)) {
                dead.push(this.getStats(id));
            }
        }
        return dead;
    }

    // Get total speed
    getTotalSpeed() {
        let totalSpeed = 0;
        for (const [id, chunk] of this.chunks) {
            if (chunk.status === 'downloading') {
                totalSpeed += chunk.avgSpeed || 0;
            }
        }
        return totalSpeed;
    }

    // Get active thread count
    getActiveThreadCount() {
        let count = 0;
        for (const [id, chunk] of this.chunks) {
            if (chunk.status === 'downloading' || chunk.status === 'pending') {
                count++;
            }
        }
        return count;
    }

    // Cleanup
    cleanup(chunkId) {
        this.chunks.delete(chunkId);
        this.speedHistory.delete(chunkId);
        this.lastActiveTime.delete(chunkId);
        this.splitHistory.delete(chunkId);
    }

    cleanupAll() {
        this.chunks.clear();
        this.speedHistory.clear();
        this.lastActiveTime.clear();
        this.splitHistory.clear();
    }
}

// ============== URL REFRESH MANAGER ==============
class URLRefreshManager {
    constructor() {
        this.pendingRequests = new Map();
    }

    async checkUrlStatus(url, headers = {}) {
        return new Promise((resolve) => {
            try {
                const parsedUrl = new URL(url);
                const protocol = parsedUrl.protocol === 'https:' ? https : http;
                const settings = store.get('settings');

                const options = {
                    method: 'HEAD',
                    hostname: parsedUrl.hostname,
                    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                    path: parsedUrl.pathname + parsedUrl.search,
                    headers: {
                        'User-Agent': settings.userAgent,
                        ...headers
                    }
                };

                const req = protocol.request(options, (res) => {
                    resolve({
                        valid: res.statusCode === 200 || res.statusCode === 206,
                        statusCode: res.statusCode,
                        contentLength: parseInt(res.headers['content-length'] || '0'),
                        acceptRanges: res.headers['accept-ranges'] === 'bytes',
                        redirectUrl: res.headers.location || null
                    });
                });

                req.on('error', (error) => {
                    resolve({ valid: false, error: error.message, statusCode: 0 });
                });

                req.setTimeout(10000, () => {
                    req.destroy();
                    resolve({ valid: false, error: 'Timeout', statusCode: 0 });
                });

                req.end();
            } catch (error) {
                resolve({ valid: false, error: error.message, statusCode: 0 });
            }
        });
    }

    isExpiredUrlError(error, statusCode) {
        const expiredCodes = [401, 403, 410, 456];
        const expiredMessages = ['forbidden', 'unauthorized', 'expired', 'token', 'signature', 'access denied'];

        if (expiredCodes.includes(statusCode)) return true;
        if (error && expiredMessages.some(msg => error.toLowerCase().includes(msg))) return true;

        return false;
    }
}

// ============== SMART DOWNLOAD ENGINE ==============
const DEFAULT_ENGINE_SETTINGS = {
    downloadPath: DOWNLOADS_PATH,
    maxConcurrent: 2,
    chunkCount: SMART_CHUNK_CONFIG.DEFAULT_THREADS,
    speedLimit: 0,
    enableSmartChunks: true,
    enableAutoSplit: true,
    enableDynamicThreads: true,
    startWithWindows: false,
    minimizeToTray: true,
    autoResume: true,
    showNotification: true,
    connectionTimeout: 30,
    maxRetries: 5,
    retryDelay: 5000,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    fileConflictMode: 'ask',
    enableClipboardMonitor: true
};

class SmartDownloadEngine {
    constructor() {
        this.activeDownloads = new Map();
        this.queuePaused = store.get('queuePaused') === true;
        this.settings = this.sanitizeSettings({ ...DEFAULT_ENGINE_SETTINGS, ...store.get('settings') });
        this.chunkMonitor = new ChunkMonitor();
        this.urlRefreshManager = new URLRefreshManager();
        this.globalSpeedHistory = [];
        this.monitorInterval = null;
        this.nextBandwidthSlot = 0;
        this.scheduledSpeedLimit = 0;
    }

    sanitizeSettings(settings) {
        const toBoundedInt = (value, fallback, min, max) => {
            const parsed = Number.parseInt(value, 10);
            return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
        };
        const retryDelayValue = Number.parseInt(settings.retryDelay, 10);
        // Older renderer versions stored this UI value in seconds while the
        // download engine consumes milliseconds. Convert those saved values.
        const retryDelayMs = Number.isFinite(retryDelayValue)
            ? (retryDelayValue > 0 && retryDelayValue <= 60 ? retryDelayValue * 1000 : retryDelayValue)
            : 5000;

        return {
            ...settings,
            connectionTimeout: toBoundedInt(settings.connectionTimeout, 30, 5, 300),
            maxRetries: toBoundedInt(settings.maxRetries, 5, 0, 20),
            retryDelay: Math.max(1000, Math.min(60000, retryDelayMs)),
            maxConcurrent: toBoundedInt(settings.maxConcurrent, 2, 1, 4),
            chunkCount: toBoundedInt(settings.chunkCount, SMART_CHUNK_CONFIG.DEFAULT_THREADS, 1, SMART_CHUNK_CONFIG.MAX_THREADS),
            speedLimit: Math.max(0, parseInt(settings.speedLimit, 10) || 0)
        };
    }

    getSettings() {
        return this.settings;
    }

    updateSettings(newSettings) {
        this.settings = this.sanitizeSettings({ ...this.settings, ...newSettings });
        store.set('settings', this.settings);
        this.startQueuedDownloads();
    }

    setScheduledSpeedLimit(limitKBps) {
        this.scheduledSpeedLimit = Math.max(0, Number(limitKBps) || 0);
    }

    createBandwidthThrottle(signal) {
        let timer = null;
        let abortHandler = null;
        let pendingTransform = null;
        const engine = this;
        return new Transform({
            transform(chunk, _encoding, callback) {
                pendingTransform = callback;
                const outputStream = this;

                const finish = (error) => {
                    if (!pendingTransform) return;
                    clearTimeout(timer);
                    timer = null;
                    if (abortHandler) signal.removeEventListener('abort', abortHandler);
                    abortHandler = null;
                    const complete = pendingTransform;
                    pendingTransform = null;
                    complete(error || undefined);
                };

                const emitChunk = () => {
                    if (signal.aborted) {
                        finish(new DOMException('Download aborted', 'AbortError'));
                        return;
                    }
                    const configuredLimit = Math.max(0, Number(engine.settings.speedLimit) || 0);
                    const scheduledLimit = Math.max(0, Number(engine.scheduledSpeedLimit) || 0);
                    const activeLimit = configuredLimit > 0 && scheduledLimit > 0
                        ? Math.min(configuredLimit, scheduledLimit)
                        : Math.max(configuredLimit, scheduledLimit);
                    const limitBytesPerSecond = activeLimit * 1024;
                    if (!limitBytesPerSecond) {
                        outputStream.push(chunk.subarray(emitChunk.offset));
                        finish();
                        return;
                    }

                    const sliceSize = Math.max(1, Math.min(16 * 1024, Math.floor(limitBytesPerSecond / 4)));
                    const end = Math.min(chunk.length, emitChunk.offset + sliceSize);
                    const slice = chunk.subarray(emitChunk.offset, end);
                    const now = Date.now();
                    const slotStart = Math.max(now, engine.nextBandwidthSlot);
                    const durationMs = Math.max(1, (slice.length / limitBytesPerSecond) * 1000);
                    engine.nextBandwidthSlot = slotStart + durationMs;
                    timer = setTimeout(() => {
                        if (signal.aborted) {
                            finish(new DOMException('Download aborted', 'AbortError'));
                            return;
                        }
                        outputStream.push(slice);
                        emitChunk.offset = end;
                        if (emitChunk.offset >= chunk.length) finish();
                        else emitChunk();
                    }, Math.max(0, slotStart - now) + durationMs);
                };
                emitChunk.offset = 0;
                abortHandler = () => finish(new DOMException('Download aborted', 'AbortError'));
                signal.addEventListener('abort', abortHandler, { once: true });
                emitChunk();
            },
            destroy(error, callback) {
                if (timer) clearTimeout(timer);
                timer = null;
                if (abortHandler) signal.removeEventListener('abort', abortHandler);
                abortHandler = null;
                const complete = pendingTransform;
                pendingTransform = null;
                if (complete) complete(error || new Error('Bandwidth throttle stopped'));
                callback(error);
            }
        });
    }

    // Detect file category from filename extension and content-type
    detectCategory(filename, contentType) {
        const ext = (filename || '').split('.').pop().toLowerCase();
        const ct = (contentType || '').toLowerCase();

        // Video
        if (['mp4', 'mkv', 'avi', 'webm', 'mov', 'flv', 'wmv', 'm4v', '3gp', 'ts', 'mpg', 'mpeg'].includes(ext) ||
            ct.startsWith('video/')) {
            return 'video';
        }

        // Audio
        if (['mp3', 'flac', 'aac', 'ogg', 'wav', 'wma', 'm4a', 'opus', 'aiff'].includes(ext) ||
            ct.startsWith('audio/')) {
            return 'audio';
        }

        // Document
        if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'csv', 'epub', 'odt'].includes(ext) ||
            ct.includes('pdf') || ct.includes('document') || ct.includes('text/')) {
            return 'document';
        }

        // Software
        if (['exe', 'msi', 'dmg', 'deb', 'rpm', 'apk', 'appimage', 'setup'].includes(ext) ||
            ct.includes('application/x-msi') || ct.includes('application/x-executable')) {
            return 'software';
        }

        // Archive
        if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'cab'].includes(ext) ||
            ct.includes('zip') || ct.includes('compressed') || ct.includes('archive')) {
            return 'archive';
        }

        return 'other';
    }

    // Get file info
    async getFileInfo(url, authHeaders = {}, credentialOrigin = null, redirectCount = 0, useRangeProbe = false) {
        return new Promise((resolve, reject) => {
            let parsedUrl;
            try {
                parsedUrl = new URL(url);
                if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Only HTTP and HTTPS downloads are supported');
            } catch (error) {
                reject(error);
                return;
            }
            const protocol = parsedUrl.protocol === 'https:' ? https : http;
            const authorizedOrigin = credentialOrigin || parsedUrl.origin;

            const options = {
                method: useRangeProbe ? 'GET' : 'HEAD',
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                headers: {
                    'User-Agent': this.settings.userAgent,
                    'Accept': '*/*',
                    'Accept-Encoding': 'identity',
                    'Connection': 'keep-alive',
                    ...(useRangeProbe ? { 'Range': 'bytes=0-0' } : {}),
                    ...(parsedUrl.origin === authorizedOrigin ? authHeaders : {})
                }
            };

            const req = protocol.request(options, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    if (redirectCount >= 10) return reject(new Error('Too many redirects while checking the file'));
                    const redirectUrl = new URL(res.headers.location, parsedUrl).href;
                    return this.getFileInfo(redirectUrl, authHeaders, authorizedOrigin, redirectCount + 1, useRangeProbe)
                        .then(resolve).catch(reject);
                }

                if (!useRangeProbe && [403, 405, 501].includes(res.statusCode)) {
                    res.resume();
                    return this.getFileInfo(url, authHeaders, credentialOrigin, redirectCount, true).then(resolve).catch(reject);
                }
                if (res.statusCode !== 200 && res.statusCode !== 206) {
                    res.resume();
                    if (this.urlRefreshManager.isExpiredUrlError(null, res.statusCode)) {
                        return reject(new Error('URL_EXPIRED'));
                    }
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }

                const contentRange = String(res.headers['content-range'] || '').match(/^bytes\s+\d+-\d+\/(\d+|\*)$/i);
                const contentLength = useRangeProbe && res.statusCode === 206
                    ? (contentRange && contentRange[1] !== '*' ? Number(contentRange[1]) : 0)
                    : parseInt(res.headers['content-length'] || '0', 10) || 0;
                const acceptRanges = res.headers['accept-ranges'];
                const contentDisposition = res.headers['content-disposition'];
                const etag = res.headers['etag'];
                const lastModified = res.headers['last-modified'];

                let filename = '';
                if (contentDisposition) {
                    const extended = contentDisposition.match(/filename\*\s*=\s*(?:UTF-8'[^']*')?([^;]+)/i);
                    const plain = contentDisposition.match(/filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]+))/i);
                    const candidate = extended?.[1]?.trim() || plain?.[1] || plain?.[2];
                    if (candidate) {
                        try { filename = decodeURIComponent(candidate.trim().replace(/^"|"$/g, '')); }
                        catch { filename = candidate.trim().replace(/^"|"$/g, ''); }
                    }
                }
                if (!filename) {
                    try { filename = path.basename(decodeURIComponent(parsedUrl.pathname)); }
                    catch { filename = path.basename(parsedUrl.pathname); }
                }
                if (!filename || filename === '/' || filename === '.') filename = 'download';
                if (!path.extname(filename)) {
                    const mimeExtensions = {
                        'application/pdf': '.pdf', 'application/zip': '.zip',
                        'application/gzip': '.gz', 'application/json': '.json',
                        'application/xml': '.xml', 'application/epub+zip': '.epub',
                        'application/vnd.android.package-archive': '.apk',
                        'application/octet-stream': '', 'audio/mpeg': '.mp3',
                        'audio/mp4': '.m4a', 'audio/ogg': '.ogg', 'audio/wav': '.wav',
                        'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
                        'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
                        'image/webp': '.webp', 'image/svg+xml': '.svg',
                        'text/plain': '.txt', 'text/csv': '.csv', 'text/html': '.html'
                    };
                    const contentType = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
                    filename += mimeExtensions[contentType] || '';
                }

                const result = {
                    filename: this.sanitizeFilename(filename),
                    size: contentLength,
                    supportsResume: (acceptRanges === 'bytes' || (useRangeProbe && res.statusCode === 206)) && contentLength > 0,
                    contentType: res.headers['content-type'],
                    etag,
                    lastModified,
                    finalUrl: parsedUrl.href,
                    statusCode: res.statusCode
                };
                if (useRangeProbe && res.statusCode === 200) res.destroy();
                else res.resume();
                resolve(result);
            });

            req.on('error', (error) => {
                if (this.urlRefreshManager.isExpiredUrlError(error.message, 0)) {
                    reject(new Error('URL_EXPIRED'));
                } else {
                    reject(error);
                }
            });

            const timeout = (parseInt(this.settings.connectionTimeout) || 30) * 1000;
            req.setTimeout(timeout, () => {
                req.destroy();
                reject(new Error('Connection timeout'));
            });

            req.end();
        });
    }

    sanitizeFilename(filename) {
        let safeName = String(filename || '')
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
            .replace(/[. ]+$/g, '')
            .trim();
        if (!safeName || safeName === '.' || safeName === '..') safeName = 'download';
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safeName)) safeName = `_${safeName}`;
        return safeName.substring(0, 255);
    }

    // Start download with smart chunks
    async startDownload(url, savePath = null, options = {}) {
        let currentUrl = url;
        let refreshAttempts = 0;
        const maxRefreshAttempts = 3;

        let info;
        while (!info && refreshAttempts < maxRefreshAttempts) {
            try {
                info = await this.getFileInfo(currentUrl);
                break;
            } catch (error) {
                if (error.message === 'URL_EXPIRED' && this.settings.enableLinkRefresh && options.pageUrl) {
                    refreshAttempts++;
                    continue;
                }
                throw error;
            }
        }

        if (!info) {
            throw new Error('Failed to get file info');
        }
        return this.startDownloadWithInfo(url, savePath, options, info, currentUrl);
    }

    async startDownloadWithInfo(url, savePath = null, options = {}, info, currentUrl = url) {
        if (!info || typeof info.filename !== 'string' || !Number.isFinite(Number(info.size))) {
            throw new Error('Invalid download metadata');
        }
        const duplicate = findDuplicateDownload(store.get('downloads') || [], url, filePath => fs.existsSync(filePath));
        if (duplicate) {
            if (duplicate.action === 'resume') this.resumeDownload(duplicate.download.id);
            return { ...duplicate.download, duplicate: true, resumed: duplicate.action === 'resume' };
        }
        const id = uuidv4();
        currentUrl = info.finalUrl || currentUrl;
        const requestedThreads = Number.parseInt(options.threads, 10);
        const configuredThreads = Number(this.settings.chunkCount) || SMART_CHUNK_CONFIG.DEFAULT_THREADS;
        const initialThreads = Math.max(1, Math.min(
            Number.isFinite(requestedThreads) ? requestedThreads : configuredThreads,
            SMART_CHUNK_CONFIG.MAX_THREADS
        ));

        const filename = this.sanitizeFilename(options.filename || info.filename) || 'download';
        const category = this.detectCategory(filename, info.contentType);

        // Category-based subfolder mapping
        const categoryFolders = {
            video: 'Videos',
            audio: 'Music',
            document: 'Documents',
            software: 'Programs',
            archive: 'Archives',
            other: ''
        };

        const basePath = savePath || this.settings.downloadPath || DOWNLOADS_PATH;
        const categoryFolder = categoryFolders[category] || '';
        const downloadDir = categoryFolder ? path.join(basePath, categoryFolder) : basePath;

        // Ensure category folder exists
        if (!fs.existsSync(downloadDir)) {
            fs.mkdirSync(downloadDir, { recursive: true });
        }

        const download = {
            id,
            url: currentUrl,
            originalUrl: url,
            finalUrl: info.finalUrl || currentUrl,
            filename: filename,
            savePath: path.join(downloadDir, filename),
            totalBytes: isNaN(info.size) ? 0 : (parseInt(info.size) || 0),
            downloadedBytes: 0,
            status: 'queued',
            progress: 0,
            speed: 0,
            avgSpeed: 0,
            chunkCount: initialThreads,
            activeChunks: 0,
            supportsResume: info.supportsResume,
            etag: info.etag,
            lastModified: info.lastModified,
            createdAt: new Date().toISOString(),
            startedAt: null,
            completedAt: null,
            errorMessage: null,
            category: this.detectCategory(info.filename, info.contentType),
            pageUrl: options.pageUrl,
            extensionRequestId: options.extensionRequestId || null,
            encryptedAuthHeaders: options.encryptedAuthHeaders?.encrypted || null,
            authHeaderOrigin: options.authHeaderOrigin || null,
            smartChunkEnabled: this.settings.enableSmartChunks,
            dynamicThreadsEnabled: this.settings.enableDynamicThreads
        };

        // Create initial chunks
        download.chunks = splitChunk(download, info.size, initialThreads);

        // Save to store
        const downloads = store.get('downloads') || [];
        downloads.unshift(download);
        store.set('downloads', downloads);

        // Save metadata
        this.saveChunkMetadata(download);

        // Start downloading
        this.processDownload(download);

        return download;
    }


    saveChunkMetadata(download) {
        const metadataPath = path.join(CHUNKS_PATH, download.id, 'metadata.json');
        const dir = path.dirname(metadataPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(metadataPath, JSON.stringify({
            id: download.id,
            url: download.url,
            originalUrl: download.originalUrl,
            filename: download.filename,
            totalBytes: download.totalBytes,
            chunkCount: download.chunkCount,
            chunks: download.chunks,
            etag: download.etag,
            pageUrl: download.pageUrl
        }, null, 2));
    }

    reconcileChunkState(download) {
        if (!download.supportsResume || !Array.isArray(download.chunks)) return;
        for (const chunk of download.chunks) {
            const chunkPath = path.join(CHUNKS_PATH, download.id, `chunk_${chunk.index}.tmp`);
            chunk.tempPath = chunkPath;
            const expectedBytes = Math.max(0, chunk.endByte - chunk.startByte + 1);
            let actualBytes = 0;
            try {
                const stat = fs.statSync(chunkPath);
                if (stat.isFile()) actualBytes = stat.size;
            } catch (_) { /* Missing chunk files are treated as empty. */ }

            if (actualBytes > expectedBytes) {
                try { fs.unlinkSync(chunkPath); } catch (_) { /* The next write will report any filesystem issue. */ }
                actualBytes = 0;
            }
            chunk.downloadedBytes = actualBytes;
            chunk.status = expectedBytes > 0 && actualBytes === expectedBytes ? 'completed' : 'pending';
            chunk.error = null;
            chunk.errorCode = null;
        }
        download.downloadedBytes = download.chunks.reduce((sum, chunk) => sum + (chunk.downloadedBytes || 0), 0);
        download.progress = download.totalBytes > 0
            ? Math.max(0, Math.min(100, (download.downloadedBytes / download.totalBytes) * 100))
            : 0;
        const downloads = store.get('downloads') || [];
        const downloadIndex = downloads.findIndex(item => item.id === download.id);
        if (downloadIndex !== -1) {
            downloads[downloadIndex].downloadedBytes = download.downloadedBytes;
            downloads[downloadIndex].progress = download.progress;
            store.set('downloads', downloads);
        }
        this.saveChunkMetadata(download);
    }

    // Load chunk metadata
    loadChunkMetadata(downloadId) {
        const metadataPath = path.join(CHUNKS_PATH, downloadId, 'metadata.json');
        if (fs.existsSync(metadataPath)) {
            return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        }
        return null;
    }

    // Main download processor with smart chunk management
    async processDownload(download) {
        console.log('[DEBUG] processDownload started:', download.id, 'file:', download.filename);
        const downloads = store.get('downloads');
        const downloadIndex = downloads.findIndex(d => d.id === download.id);
        if (downloadIndex === -1) {
            console.error('[DEBUG] Download not found in store:', download.id);
            return;
        }

        if (this.activeDownloads.has(download.id) || activeYtDlpJobs.has(download.id) || activeTorrentJobs.has(download.id)) return;
        const maxConcurrent = Math.max(1, Math.min(10, this.settings.maxConcurrent || 3));
        if (this.queuePaused || this.getActiveJobCount() >= maxConcurrent) {
            downloads[downloadIndex].status = 'queued';
            store.set('downloads', downloads);
            return;
        }

        if (downloads[downloadIndex].isYtDlp) {
            return startYtDlpJob(downloads[downloadIndex]);
        }
        if (downloads[downloadIndex].isTorrent) {
            return startTorrentJob(downloads[downloadIndex]);
        }

        downloads[downloadIndex].status = 'downloading';
        downloads[downloadIndex].startedAt = new Date().toISOString();
        store.set('downloads', downloads);

        const abortController = new AbortController();
        this.activeDownloads.set(download.id, abortController);

        // Start chunk monitor
        this.startChunkMonitor(download.id);

        try {
            const chunkDir = path.join(CHUNKS_PATH, download.id);
            console.log('[DEBUG] Chunk directory:', chunkDir);
            if (!fs.existsSync(chunkDir)) fs.mkdirSync(chunkDir, { recursive: true });

            this.reconcileChunkState(download);

            console.log('[DEBUG] Starting download - supportsResume:', download.supportsResume, 'chunkCount:', download.chunkCount);
            if (download.supportsResume && download.chunkCount > 1) {
                console.log('[DEBUG] Using smart chunks download');
                try {
                    await this.downloadWithSmartChunks(download, abortController.signal);
                } catch (error) {
                    if (abortController.signal.aborted || !['RANGE_UNSUPPORTED', 'INVALID_RANGE_RESPONSE'].includes(error.code)) {
                        throw error;
                    }

                    // Some servers advertise ranges but ignore or misreport them.
                    // Discard partial chunk files and restart as one safe stream.
                    log(`Range download unavailable for ${download.filename}; falling back to single connection`);
                    this.cleanupChunks(download.id);
                    download.supportsResume = false;
                    download.chunkCount = 1;
                    download.chunks = splitChunk(download, download.totalBytes, 1);
                    download.downloadedBytes = 0;
                    download.progress = 0;
                    const currentDownloads = store.get('downloads') || [];
                    const currentIndex = currentDownloads.findIndex(item => item.id === download.id);
                    if (currentIndex !== -1) {
                        Object.assign(currentDownloads[currentIndex], {
                            supportsResume: false,
                            chunkCount: 1,
                            chunks: download.chunks,
                            downloadedBytes: 0,
                            progress: 0
                        });
                        store.set('downloads', currentDownloads);
                    }
                    this.saveChunkMetadata(download);
                    await this.downloadSingleThreadWithRetries(download, abortController.signal);
                }
            } else {
                console.log('[DEBUG] Using single thread download');
                await this.downloadSingleThreadWithRetries(download, abortController.signal);
            }

            // Merge chunks
            if (download.supportsResume && download.chunkCount > 1) {
                await this.mergeChunks(download, abortController.signal);
            }

            const completedFile = await fs.promises.stat(download.savePath);
            if (!completedFile.isFile()) throw new Error('The server did not create a downloadable file');
            if (download.totalBytes > 0 && completedFile.size !== download.totalBytes) {
                throw new Error(`Incomplete download: saved ${completedFile.size} of ${download.totalBytes} bytes`);
            }
            if (completedFile.size === 0 && download.totalBytes > 0) {
                throw new Error('The server returned an empty file instead of the requested download');
            }
            download.downloadedBytes = completedFile.size;
            download.totalBytes = completedFile.size;
            download.progress = 100;
            download.filename = path.basename(download.savePath);
            const completedDownloads = store.get('downloads') || [];
            const completedIndex = completedDownloads.findIndex(item => item.id === download.id);
            if (completedIndex !== -1) {
                Object.assign(completedDownloads[completedIndex], {
                    downloadedBytes: completedFile.size,
                    totalBytes: completedFile.size,
                    progress: 100,
                    filename: download.filename
                });
                store.set('downloads', completedDownloads);
            }

            this.updateDownloadStatus(download.id, 'completed');
            this.cleanupChunks(download.id);
            this.activeDownloads.delete(download.id);
            decryptedAuthHeaders.delete(download.id);
            this.stopChunkMonitor(download);

            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('download-complete', {
                    id: download.id,
                    filename: download.filename,
                    savePath: download.savePath,
                    totalBytes: completedFile.size,
                    downloadedBytes: completedFile.size
                });
            }
            this.startQueuedDownloads();
        } catch (error) {
            if (error.name === 'AbortError') {
                const currentDownload = this.getDownload(download.id);
                if (currentDownload?.status !== 'cancelled') {
                    this.updateDownloadStatus(download.id, 'paused');
                }
            } else {
                this.updateDownloadStatus(download.id, 'failed', error.message);
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('download-error', { id: download.id, error: error.message });
                }
            }
            this.activeDownloads.delete(download.id);
            this.stopChunkMonitor(download);
            this.startQueuedDownloads();
        }
    }

    async downloadSingleThreadWithRetries(download, signal) {
        let attempt = 0;
        const configuredRetries = Number(this.settings.maxRetries);
        const maxRetries = Number.isFinite(configuredRetries) ? Math.max(0, Math.min(20, configuredRetries)) : 5;
        while (true) {
            try {
                await this.downloadSingleThread(download, signal);
                return;
            } catch (error) {
                const nonRetryableClientError = /HTTP 4\d\d/.test(error.message) && !/HTTP (408|429)/.test(error.message);
                if (signal.aborted || error.name === 'AbortError' || nonRetryableClientError || attempt >= maxRetries) throw error;
                const waitMs = Math.min((this.settings.retryDelay || 1000) * (2 ** attempt), 30000);
                attempt++;
                this.updateDownloadStatus(download.id, 'retrying', error.message);
                await new Promise(resolve => setTimeout(resolve, waitMs));
                if (signal.aborted) throw new DOMException('Download aborted', 'AbortError');
            }
        }
    }

    // Smart chunk download with dynamic management
    async downloadWithSmartChunks(download, signal) {
        const activeThreads = new Map();
        const maxConcurrentThreads = Math.min(download.chunkCount || this.settings.chunkCount || 8, SMART_CHUNK_CONFIG.MAX_THREADS);
        const speedHistory = [];
        let lastBytes = 0;
        let lastTime = Date.now();
        let lastMonitorTime = Date.now();

        // Process chunks
        const processChunk = async (chunk) => {
            if (signal.aborted) return;

            // Register chunk in monitor
            this.chunkMonitor.registerChunk(chunk.id, chunk.startByte, chunk.endByte);

            try {
            const onProgress = (progress) => {
                    // Update monitor
                    this.chunkMonitor.updateProgress(chunk.id, progress.downloaded, progress.currentByte);

                    // Calculate total speed
                    const now = Date.now();
                    const timeDiff = now - lastTime;
                    if (timeDiff >= 500) {
                        const totalDownloaded = download.chunks.reduce((sum, c) => sum + c.downloadedBytes, 0);
                        const bytesDiff = totalDownloaded - lastBytes;
                        // Guard against division by zero and ensure valid numbers
                        const speed = (timeDiff > 0 && bytesDiff >= 0) ? (bytesDiff / timeDiff) * 1000 : 0;
                        const safeSpeed = isFinite(speed) ? speed : 0;

                        speedHistory.push(safeSpeed);
                        if (speedHistory.length > 20) speedHistory.shift();
                        // Guard against empty array division
                        const avgSpeed = speedHistory.length > 0
                            ? speedHistory.reduce((a, b) => a + b, 0) / speedHistory.length
                            : 0;

                        lastBytes = totalDownloaded;
                        lastTime = now;

                        download.downloadedBytes = totalDownloaded;
                        download.speed = safeSpeed;
                        download.avgSpeed = avgSpeed;
                        const rawProgress = download.totalBytes > 0 ? (totalDownloaded / download.totalBytes) * 100 : 0;
                        download.progress = isFinite(rawProgress) ? Math.max(0, Math.min(100, rawProgress)) : 0;
                        download.activeChunks = activeThreads.size;

                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('download-progress', {
                                id: download.id,
                                progress: download.progress,
                                downloaded: totalDownloaded,
                                total: download.totalBytes,
                                speed: safeSpeed,
                                avgSpeed,
                                threads: download.activeChunks,
                                chunks: download.chunks.map(c => ({
                                    id: c.id,
                                    index: c.index,
                                    progress: c.endByte > c.startByte ? (c.downloadedBytes / (c.endByte - c.startByte)) * 100 : 0,
                                    speed: c.speed || 0
                                }))
                            });
                        }
                    }
            };

            let attempt = 0;
            const configuredRetries = Number(this.settings.maxRetries);
            const maxRetries = Number.isFinite(configuredRetries) ? Math.max(0, Math.min(20, configuredRetries)) : 5;
            while (true) {
                try {
                    await this.downloadChunk(download, chunk, signal, onProgress);
                    break;
                } catch (error) {
                    if (signal.aborted || error.name === 'AbortError') throw error;
                    if (['RANGE_UNSUPPORTED', 'INVALID_RANGE_RESPONSE', 'REMOTE_FILE_CHANGED', 'URL_EXPIRED'].includes(error.code || error.message)) {
                        throw error;
                    }
                    if (/HTTP 4\d\d/.test(error.message) && !/HTTP (408|429)/.test(error.message)) throw error;

                    const actualBytes = fs.existsSync(chunk.tempPath) ? fs.statSync(chunk.tempPath).size : 0;
                    const chunkLength = chunk.endByte - chunk.startByte + 1;
                    chunk.downloadedBytes = Math.max(0, Math.min(actualBytes, chunkLength));
                    if (attempt >= maxRetries) throw error;

                    chunk.status = 'retrying';
                    chunk.retryCount = attempt + 1;
                    chunk.error = error.message;
                    this.updateChunkMetadata(download, chunk);
                    const waitMs = Math.min((this.settings.retryDelay || 1000) * (2 ** attempt), 30000);
                    attempt++;
                    await new Promise(resolve => setTimeout(resolve, waitMs));
                    if (signal.aborted) throw new DOMException('Download aborted', 'AbortError');
                }
            }

                this.chunkMonitor.markCompleted(chunk.id);
                chunk.status = 'completed';
                this.updateChunkMetadata(download, chunk);
            } catch (error) {
                if (signal.aborted) {
                    chunk.status = 'paused';
                } else {
                    chunk.status = 'failed';
                    chunk.error = error.message;
                    chunk.errorCode = error.code || null;
                    this.chunkMonitor.markFailed(chunk.id, error.message);
                }
                throw error;
            }
        };

        // Initial thread allocation
        const chunksToProcess = [...download.chunks].filter(c => c.status !== 'completed');

        for (const chunk of chunksToProcess) {
            if (signal.aborted) break;

            // Wait for available thread slot
            while (activeThreads.size >= maxConcurrentThreads) {
                await new Promise(resolve => setTimeout(resolve, 100));
                if (signal.aborted) break;
            }

            if (signal.aborted) break;

            chunk.status = 'downloading';
            this.updateChunkMetadata(download, chunk);

            const threadPromise = processChunk(chunk)
                .then(() => {
                    activeThreads.delete(chunk.id);
                })
                .catch((error) => {
                    activeThreads.delete(chunk.id);
                    if (!signal.aborted) {
                        // Handle chunk failure - will be retried by monitor
                        console.log(`Chunk ${chunk.index} failed:`, error.message);
                    }
                });

            activeThreads.set(chunk.id, threadPromise);
        }

        // Smart chunk monitor loop
        const monitorLoop = setInterval(() => {
            if (signal.aborted) {
                clearInterval(monitorLoop);
                return;
            }

            // Check for slow chunks
            if (this.settings.enableAutoSplit) {
                const slowChunks = this.chunkMonitor.getSlowChunks();
                for (const slowChunk of slowChunks) {
                    if (this.chunkMonitor.canSplit(slowChunk.id)) {
                        // Log slow chunk detection
                        console.log(`Slow chunk detected: ${slowChunk.id}, speed: ${slowChunk.avgSpeed}`);

                        // Could implement chunk splitting here
                        // For now, just mark it for monitoring
                    }
                }
            }

            // Check for dead chunks
            const deadChunks = this.chunkMonitor.getDeadChunks();
            for (const deadChunk of deadChunks) {
                console.log(`Dead chunk detected: ${deadChunk.id}`);
                // Could implement chunk replacement here
            }

        }, SMART_CHUNK_CONFIG.MONITOR_INTERVAL);

        // Wait for all threads to complete
        await Promise.all(Array.from(activeThreads.values()));

        clearInterval(monitorLoop);
        if (signal.aborted) throw new DOMException('Download aborted', 'AbortError');
        const failedChunk = download.chunks.find(chunk => chunk.status !== 'completed');
        if (failedChunk) {
            const error = new Error(failedChunk.error || `Chunk ${failedChunk.index} did not complete`);
            error.code = failedChunk.errorCode;
            throw error;
        }
    }

    // Download single chunk
    downloadChunk(download, chunk, signal, onProgress) {
        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(download.finalUrl || download.url);
            const protocol = parsedUrl.protocol === 'https:' ? https : http;

            const resumeFrom = chunk.downloadedBytes;
            const startByte = chunk.startByte + resumeFrom;
            const endByte = chunk.endByte;
            const expectedBytes = endByte - startByte + 1;

            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                headers: {
                    'User-Agent': this.settings.userAgent,
                    'Accept': '*/*',
                    'Connection': 'keep-alive',
                    'Referer': download.pageUrl || download.url || download.originalUrl || '',
                    'Range': `bytes=${startByte}-${endByte >= 0 ? endByte : ''}`
                }
            };
            options.headers = requestHeadersForDownload(download, parsedUrl.href, options.headers);

            let response = null;
            let fileStream = null;
            let throttleStream = null;
            let settled = false;
            let downloadedThisSession = 0;
            let receivedThisSession = 0;
            const cleanup = (error) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', onAbort);
                if (response && !response.destroyed) response.destroy();
                if (throttleStream && !throttleStream.destroyed) throttleStream.destroy(error);
                if (fileStream && !fileStream.closed) {
                    fileStream.once('close', () => { if (error) reject(error); });
                    fileStream.destroy();
                } else if (error) {
                    reject(error);
                }
            };
            const onAbort = () => {
                const error = new DOMException('Download aborted', 'AbortError');
                req.destroy(error);
                cleanup(error);
            };

            const req = protocol.request(options, (res) => {
                response = res;
                if (res.statusCode === 401 || res.statusCode === 403) {
                    res.resume();
                    return cleanup(new Error('URL_EXPIRED'));
                }

                if (res.statusCode === 200) {
                    res.resume();
                    const error = new Error('Server ignored the byte-range request');
                    error.code = 'RANGE_UNSUPPORTED';
                    return cleanup(error);
                }
                if (res.statusCode !== 206) {
                    res.resume();
                    return cleanup(new Error(`HTTP ${res.statusCode}`));
                }

                const rangeMatch = String(res.headers['content-range'] || '').match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i);
                const returnedTotal = rangeMatch && rangeMatch[3] !== '*' ? Number(rangeMatch[3]) : 0;
                if (!rangeMatch || Number(rangeMatch[1]) !== startByte || Number(rangeMatch[2]) !== endByte ||
                    (download.totalBytes > 0 && returnedTotal !== download.totalBytes)) {
                    res.resume();
                    const error = new Error('Server returned an invalid Content-Range response');
                    error.code = 'INVALID_RANGE_RESPONSE';
                    return cleanup(error);
                }
                if (download.etag && res.headers.etag && download.etag !== res.headers.etag) {
                    res.resume();
                    const error = new Error('The remote file changed during download');
                    error.code = 'REMOTE_FILE_CHANGED';
                    return cleanup(error);
                }
                if (download.lastModified && res.headers['last-modified'] &&
                    download.lastModified !== res.headers['last-modified']) {
                    res.resume();
                    const error = new Error('The remote file changed during download');
                    error.code = 'REMOTE_FILE_CHANGED';
                    return cleanup(error);
                }

                const chunkDir = path.dirname(chunk.tempPath);
                if (!fs.existsSync(chunkDir)) fs.mkdirSync(chunkDir, { recursive: true });

                fileStream = fs.createWriteStream(chunk.tempPath, {
                    flags: resumeFrom > 0 ? 'a' : 'w'
                });
                throttleStream = this.createBandwidthThrottle(signal);

                res.on('data', (data) => {
                    receivedThisSession += data.length;
                    if (receivedThisSession > expectedBytes) {
                        const error = new Error('Server returned more bytes than requested');
                        error.code = 'INVALID_RANGE_RESPONSE';
                        req.destroy(error);
                        return cleanup(error);
                    }
                });

                throttleStream.on('data', (data) => {
                    downloadedThisSession += data.length;
                    chunk.downloadedBytes = resumeFrom + downloadedThisSession;
                    chunk.lastActiveTime = Date.now();

                    if (onProgress) {
                        onProgress({
                            chunk,
                            downloaded: downloadedThisSession,
                            currentByte: startByte + downloadedThisSession
                        });
                    }
                });

                throttleStream.on('error', cleanup);
                res.pipe(throttleStream).pipe(fileStream);

                fileStream.on('finish', () => {
                    const actualBytes = resumeFrom + downloadedThisSession;
                    if (actualBytes !== endByte - chunk.startByte + 1) {
                        const error = new Error(`Incomplete range: received ${actualBytes} of ${endByte - chunk.startByte + 1} bytes`);
                        error.code = 'INCOMPLETE_RANGE';
                        return cleanup(error);
                    }
                    settled = true;
                    signal.removeEventListener('abort', onAbort);
                    fileStream.close(() => resolve());
                });

                fileStream.on('error', (err) => {
                    cleanup(err);
                });
                res.on('aborted', () => cleanup(new Error('Connection ended before the range completed')));
                res.on('error', cleanup);
            });

            req.on('error', (err) => {
                cleanup(err);
            });

            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();

            const timeout = (parseInt(this.settings.connectionTimeout) || 30) * 1000;
            req.setTimeout(timeout, () => {
                const error = new Error('Connection timeout');
                req.destroy(error);
                cleanup(error);
            });

            req.end();
        });
    }

    updateChunkMetadata(download, chunk) {
        const metadata = this.loadChunkMetadata(download.id);
        if (metadata) {
            const chunkIndex = metadata.chunks.findIndex(c => c.id === chunk.id);
            if (chunkIndex !== -1) {
                metadata.chunks[chunkIndex] = { ...metadata.chunks[chunkIndex], ...chunk };
                const metadataPath = path.join(CHUNKS_PATH, download.id, 'metadata.json');
                fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
            }
        }
    }

    downloadSingleThread(download, signal, redirectCount = 0) {
        return new Promise((resolve, reject) => {
            let parsedUrl;
            try {
                parsedUrl = new URL(download.finalUrl || download.url);
                if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Unsupported download protocol');
            } catch (error) {
                reject(error);
                return;
            }
            if (signal.aborted) {
                reject(new DOMException('Download aborted', 'AbortError'));
                return;
            }
            const protocol = parsedUrl.protocol === 'https:' ? https : http;
            const tempPath = `${download.savePath}.${download.id}.part`;
            let req;
            let res = null;
            let fileStream = null;
            let throttleStream = null;
            let settled = false;
            let downloaded = 0;
            let lastBytes = 0;
            let lastTime = Date.now();
            const speedHistory = [];

            const fail = (error) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', onAbort);
                if (req && !req.destroyed) req.destroy();
                if (res && !res.destroyed) res.destroy();
                if (throttleStream && !throttleStream.destroyed) throttleStream.destroy(error);
                if (fileStream && !fileStream.closed) {
                    fileStream.once('close', () => reject(error));
                    fileStream.destroy();
                } else {
                    reject(error);
                }
            };
            const onAbort = () => fail(new DOMException('Download aborted', 'AbortError'));

            req = protocol.request({
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                headers: requestHeadersForDownload(download, parsedUrl.href, {
                    'User-Agent': this.settings.userAgent,
                    'Accept': '*/*',
                    'Referer': download.pageUrl || download.url || download.originalUrl || ''
                })
            }, (response) => {
                res = response;
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    response.resume();
                    if (redirectCount >= 10) return fail(new Error('Too many redirects'));
                    const redirectUrl = new URL(response.headers.location, parsedUrl);
                    if (!['http:', 'https:'].includes(redirectUrl.protocol)) return fail(new Error('Redirect used an unsupported protocol'));
                    signal.removeEventListener('abort', onAbort);
                    settled = true;
                    return this.downloadSingleThread({
                        ...download,
                        url: redirectUrl.href,
                        finalUrl: redirectUrl.href
                    }, signal, redirectCount + 1).then(resolve, reject);
                }
                if (response.statusCode !== 200) {
                    response.resume();
                    return fail(new Error(`HTTP ${response.statusCode}`));
                }

                const dir = path.dirname(download.savePath);
                try {
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    fileStream = fs.createWriteStream(tempPath, { flags: 'w' });
                    throttleStream = this.createBandwidthThrottle(signal);
                } catch (error) {
                    return fail(error);
                }
                const total = parseInt(response.headers['content-length'] || '0', 10) || download.totalBytes || 0;

                throttleStream.on('data', (data) => {
                    downloaded += data.length;
                    const now = Date.now();
                    const timeDiff = now - lastTime;
                    if (timeDiff >= 500) {
                        const bytesDiff = downloaded - lastBytes;
                        const safeSpeed = timeDiff > 0 && bytesDiff >= 0 ? (bytesDiff / timeDiff) * 1000 : 0;
                        speedHistory.push(safeSpeed);
                        if (speedHistory.length > 20) speedHistory.shift();
                        const avgSpeed = speedHistory.reduce((sum, value) => sum + value, 0) / speedHistory.length;
                        lastBytes = downloaded;
                        lastTime = now;
                        const progress = total > 0 ? Math.max(0, Math.min(100, (downloaded / total) * 100)) : 0;
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('download-progress', {
                                id: download.id, progress, downloaded, total,
                                speed: safeSpeed, avgSpeed, threads: 1
                            });
                        }
                    }
                });
                response.on('aborted', () => fail(new Error('Connection ended before the file completed')));
                response.on('error', fail);
                throttleStream.on('error', fail);
                fileStream.on('error', fail);
                response.pipe(throttleStream).pipe(fileStream);

                fileStream.once('finish', () => {
                    fileStream.once('close', async () => {
                        if (settled) return;
                        if (signal.aborted) return fail(new DOMException('Download aborted', 'AbortError'));
                        try {
                            const actualSize = fs.statSync(tempPath).size;
                            if (total > 0 && actualSize !== total) throw new Error(`Incomplete download: received ${actualSize} of ${total} bytes`);
                            await fs.promises.rename(tempPath, download.savePath);
                            settled = true;
                            signal.removeEventListener('abort', onAbort);
                            resolve();
                        } catch (error) {
                            fail(error);
                        }
                    });
                });
            });

            req.on('error', fail);
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
            const timeout = (parseInt(this.settings.connectionTimeout, 10) || 30) * 1000;
            req.setTimeout(timeout, () => fail(new Error('Connection timeout')));
            req.end();
        });
    }

    mergeChunks(download, signal) {
        return new Promise((resolve, reject) => {
            const sortedChunks = [...download.chunks].sort((a, b) => a.index - b.index);
            const outputDir = path.dirname(download.savePath);
            if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
            const mergePath = `${download.savePath}.${download.id}.merge.part`;
            const outputStream = fs.createWriteStream(mergePath, { flags: 'w' });
            let settled = false;
            const fail = (error) => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', onAbort);
                if (outputStream.closed) {
                    try { if (fs.existsSync(mergePath)) fs.unlinkSync(mergePath); } catch (_) { /* best-effort cleanup */ }
                    reject(error);
                    return;
                }
                outputStream.destroy();
                for (const chunk of sortedChunks) {
                    if (chunk.activeInput && !chunk.activeInput.destroyed) chunk.activeInput.destroy();
                }
                outputStream.once('close', () => {
                    try { if (fs.existsSync(mergePath)) fs.unlinkSync(mergePath); } catch (_) { /* best-effort cleanup */ }
                    reject(error);
                });
            };
            const onAbort = () => fail(new DOMException('Download aborted', 'AbortError'));
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) onAbort();

            const writeChunk = (index) => {
                if (index >= sortedChunks.length) {
                    outputStream.end();
                    return;
                }

                const chunk = sortedChunks[index];
                if (!fs.existsSync(chunk.tempPath)) {
                    return fail(new Error(`Chunk ${index} missing`));
                }

                const inputStream = fs.createReadStream(chunk.tempPath);
                chunk.activeInput = inputStream;
                inputStream.on('end', () => {
                    inputStream.close();
                    chunk.activeInput = null;
                    writeChunk(index + 1);
                });
                inputStream.on('error', fail);
                inputStream.pipe(outputStream, { end: false });
            };

            if (!settled) writeChunk(0);
            outputStream.on('finish', () => {
                outputStream.once('close', async () => {
                    if (settled) return;
                    try {
                        if (signal?.aborted) throw new DOMException('Download aborted', 'AbortError');
                        const mergedSize = fs.statSync(mergePath).size;
                        if (download.totalBytes > 0 && mergedSize !== download.totalBytes) {
                            throw new Error(`Merged file size mismatch: expected ${download.totalBytes}, got ${mergedSize}`);
                        }
                        await fs.promises.rename(mergePath, download.savePath);
                        settled = true;
                        signal?.removeEventListener('abort', onAbort);
                        resolve();
                    } catch (error) {
                        fail(error);
                    }
                });
            });
            outputStream.on('error', fail);
        });
    }

    startChunkMonitor(downloadId) {
        // Monitor is integrated into downloadWithSmartChunks
    }

    stopChunkMonitor(download) {
        for (const chunk of download?.chunks || []) {
            this.chunkMonitor.cleanup(chunk.id);
        }
    }

    startQueuedDownloads() {
        if (this.queuePaused) return;
        const maxConcurrent = Math.max(1, Math.min(10, this.settings.maxConcurrent || 3));
        while (this.getActiveJobCount() < maxConcurrent) {
            const next = this.getQueue().find(download =>
                !this.activeDownloads.has(download.id) &&
                !activeYtDlpJobs.has(download.id) &&
                !activeTorrentJobs.has(download.id)
            );
            if (!next) break;
            this.processDownload(next);
        }
    }

    getActiveJobCount() {
        return this.activeDownloads.size + activeYtDlpJobs.size + activeTorrentJobs.size;
    }

    getQueue() {
        const queue = this.getDownloads('queued');
        const savedOrder = store.get('queueOrder') || [];
        const rank = new Map(savedOrder.map((id, index) => [id, index]));
        return queue.sort((left, right) => {
            const leftRank = rank.get(left.id);
            const rightRank = rank.get(right.id);
            if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
            if (leftRank !== undefined) return -1;
            if (rightRank !== undefined) return 1;
            return new Date(left.createdAt || 0) - new Date(right.createdAt || 0);
        });
    }

    reorderQueue(ids) {
        const queued = this.getQueue();
        const queuedIds = new Set(queued.map(download => download.id));
        const requested = Array.isArray(ids) ? ids.filter((id, index) =>
            queuedIds.has(id) && ids.indexOf(id) === index
        ) : [];
        const requestedIds = new Set(requested);
        const fullOrder = [...requested, ...queued.filter(download => !requestedIds.has(download.id)).map(download => download.id)];
        store.set('queueOrder', fullOrder);
        return this.getQueue();
    }

    startQueue() {
        this.queuePaused = false;
        store.set('queuePaused', false);
        this.startQueuedDownloads();
        return { success: true };
    }

    stopQueue() {
        this.queuePaused = true;
        store.set('queuePaused', true);
        return { success: true };
    }

    cleanupChunks(downloadId) {
        const chunkDir = path.join(CHUNKS_PATH, downloadId);
        if (fs.existsSync(chunkDir)) {
            fs.rmSync(chunkDir, { recursive: true, force: true });
        }
    }

    updateDownloadStatus(id, status, errorMessage = null) {
        const downloads = store.get('downloads');
        const index = downloads.findIndex(d => d.id === id);
        if (index !== -1) {
            downloads[index].status = status;
            downloads[index].errorMessage = errorMessage;
            if (status === 'completed') {
                downloads[index].completedAt = new Date().toISOString();
                downloads[index].progress = 100;
            }
            store.set('downloads', downloads);

            // Emit status update event to renderer
            if (mainWindow && !mainWindow.isDestroyed()) {
                const message = errorMessage || `Download ${status}`;
                mainWindow.webContents.send('download-status', { id, status, message });
            }
        }
    }

    async pauseDownload(id) {
        const controller = this.activeDownloads.get(id);
        if (controller) {
            controller.abort();
            // Wait for open streams to close before another run can resume the same files.
            while (this.activeDownloads.has(id)) {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
        }

        const downloads = store.get('downloads');
        const download = downloads.find(d => d.id === id);
        if (download && download.status !== 'cancelled') {
            download.status = 'paused';
            store.set('downloads', downloads);
        }
    }

    resumeDownload(id) {
        const downloads = store.get('downloads');
        const download = downloads.find(d => d.id === id);

        if (!download) throw new Error('Download not found');
        if (!['paused', 'failed'].includes(download.status)) {
            throw new Error('Download is not paused or failed');
        }

        const metadata = this.loadChunkMetadata(id);
        if (metadata && Array.isArray(metadata.chunks) && download.supportsResume) {
            download.chunks = metadata.chunks;
        }
        this.reconcileChunkState(download);

        download.status = 'queued';
        store.set('downloads', downloads);

        this.startQueuedDownloads();
    }

    async cancelDownload(id) {
        await this.pauseDownload(id);
        decryptedAuthHeaders.delete(id);

        const downloads = store.get('downloads');
        const index = downloads.findIndex(d => d.id === id);
        if (index !== -1) {
            downloads[index].status = 'cancelled';
            store.set('downloads', downloads);
            for (const partialPath of [
                `${downloads[index].savePath}.${id}.part`,
                `${downloads[index].savePath}.${id}.merge.part`
            ]) {
                try { fs.rmSync(partialPath, { force: true }); } catch (_) { /* best-effort temporary file cleanup */ }
            }
        }

        this.cleanupChunks(id);
    }

    async deleteDownload(id) {
        await this.cancelDownload(id);
        decryptedAuthHeaders.delete(id);

        const downloads = store.get('downloads') || [];
        const filtered = downloads.filter(d => d.id !== id);
        store.set('downloads', filtered);
    }

    getDownloads(status = null) {
        const downloads = store.get('downloads') || [];
        if (status) return downloads.filter(d => d.status === status);
        return downloads;
    }

    reconcileCompletedFileStats() {
        const downloads = store.get('downloads') || [];
        let changed = false;
        for (const download of downloads) {
            if (download.status !== 'completed' || !download.savePath) continue;
            try {
                const stat = fs.statSync(download.savePath);
                if (!stat.isFile()) continue;
                if (stat.size === 0 && Number(download.totalBytes) > 0) {
                    download.status = 'failed';
                    download.progress = 0;
                    download.speed = 0;
                    download.errorMessage = 'This download was marked complete, but its saved file is empty.';
                } else {
                    download.filename = path.basename(download.savePath);
                    download.downloadedBytes = stat.size;
                    download.totalBytes = stat.size;
                    download.progress = 100;
                }
                changed = true;
            } catch (_) { /* Keep completed history if the user moved or deleted the file. */ }
        }
        if (changed) store.set('downloads', downloads);
    }

    getDownload(id) {
        const downloads = store.get('downloads') || [];
        return downloads.find(d => d.id === id);
    }

    clearHistory() {
        const downloads = store.get('downloads') || [];
        const active = downloads.filter(d => !['completed', 'cancelled', 'failed'].includes(d.status));
        store.set('downloads', active);
    }

    detectCategory(filename, contentType) {
        const ext = path.extname(filename).toLowerCase();
        const categories = {
            video: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.m3u8', '.mpd'],
            audio: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a'],
            document: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt'],
            archive: ['.zip', '.rar', '.7z', '.tar', '.gz'],
            software: ['.exe', '.msi', '.dmg', '.deb', '.rpm']
        };

        for (const [category, extensions] of Object.entries(categories)) {
            if (extensions.includes(ext)) return category;
        }
        return 'general';
    }
}

// ============== WINDOW & IPC ==============
// Flag to track if app is quitting
let isQuitting = false;
let splashWindow = null;
let onboardingWindow = null;
let firstRunStartup = false;

function closeSplashWindow() {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    splashWindow = null;
}

function createSplashWindow() {
    log('Creating splash window');
    firstRunStartup = store.get('firstRun', true);
    splashWindow = new BrowserWindow({
        width: 600,
        height: 400,
        transparent: true,
        frame: false,
        alwaysOnTop: false,
        show: false,
        resizable: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        },
        icon: path.join(__dirname, '../assets/icon.png')
    });

    splashWindow.loadFile(path.join(__dirname, 'splash.html'));

    splashWindow.once('ready-to-show', () => {
        splashWindow.show();
        log('Splash window shown');
        if (firstRunStartup) {
            // Let the short branded intro render, then replace it with onboarding.
            setTimeout(() => {
                closeSplashWindow();
                createOnboardingWindow();
            }, 900);
        } else {
            // Load the real application behind the splash; it will close the
            // splash as soon as Chromium has its first usable frame.
            createMainWindow();
        }
    });
}

function createOnboardingWindow() {
    onboardingWindow = new BrowserWindow({
        width: 700,
        height: 550,
        frame: false,
        transparent: true,
        resizable: false,
        center: true,
        show: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, '../assets/icon.png')
    });

    onboardingWindow.loadFile(path.join(__dirname, 'onboarding.html'));
}

function createMainWindow() {
    log('Creating main window...');
    try {
        mainWindow = new BrowserWindow({
            width: 1200,
            height: 800,
            minWidth: 900,
            minHeight: 600,
            frame: false,
            transparent: false,
            backgroundColor: '#0f0f1a',
            show: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js')
            },
            icon: path.join(__dirname, '../assets/icon.png')
        });

        log('BrowserWindow instance created');

        mainWindow.loadFile(path.join(__dirname, 'index.html'));
        log('index.html loaded');
        mainWindow.webContents.once('did-finish-load', flushExtensionVideoRequests);

        const iconPath = path.join(__dirname, '../assets/icon.png');
        if (fs.existsSync(iconPath)) {
            const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
            tray = new Tray(trayIcon);
            const contextMenu = Menu.buildFromTemplate([
                { label: 'Show CyberDM', click: () => { mainWindow.show(); mainWindow.focus(); } },
                { type: 'separator' },
                { label: 'Quit CyberDM', click: () => { isQuitting = true; app.quit(); } }
            ]);
            tray.setToolTip('CyberDM');
            tray.setContextMenu(contextMenu);
            log('Tray created');
        }

        mainWindow.on('ready-to-show', () => {
            log('Main window ready-to-show');
            closeSplashWindow();
            mainWindow.show();
        });

        mainWindow.on('show', () => log('Main window visible event fired'));
    } catch (err) {
        log('CRITICAL ERROR in createMainWindow: ' + err.stack);
    }
}

function parseYtDlpProgressLine(line) {
    const marker = 'CYBERDM_PROGRESS|';
    const markerIndex = line.indexOf(marker);
    if (markerIndex === -1) return null;

    const fields = line.slice(markerIndex + marker.length).split('|');
    const asNumber = (value) => {
        if (typeof value !== 'string' || !value.trim() || /^(?:NA|None)$/i.test(value.trim())) return null;
        const number = Number(value.trim());
        return Number.isFinite(number) ? number : null;
    };
    const downloaded = asNumber(fields[0]) ?? 0;
    const total = asNumber(fields[1]) ?? asNumber(fields[2]) ?? 0;
    const speed = asNumber(fields[3]) ?? 0;
    const eta = asNumber(fields[4]);
    const percent = fields[5] ? Number.parseFloat(fields[5].replace(/[^\d.]/g, '')) : NaN;

    return {
        downloaded,
        total,
        speed,
        eta,
        progress: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : (total > 0 ? Math.max(0, Math.min(100, downloaded / total * 100)) : 0)
    };
}

function attachYtDlpOutputHandlers(child, onLine) {
    const buffers = { stdout: '', stderr: '' };
    for (const streamName of Object.keys(buffers)) {
        const stream = child[streamName];
        if (!stream) continue;
        stream.on('data', (data) => {
            const lines = (buffers[streamName] + data.toString()).split(/\r?\n/);
            buffers[streamName] = lines.pop() || '';
            for (const line of lines) onLine(line, streamName);
        });
    }
    return () => {
        for (const streamName of Object.keys(buffers)) {
            if (buffers[streamName]) onLine(buffers[streamName], streamName);
            buffers[streamName] = '';
        }
    };
}

const activeYtDlpJobs = new Map();

function persistYtDlpDownload(download, changes) {
    const downloads = store.get('downloads') || [];
    const index = downloads.findIndex(item => item.id === download.id);
    if (index === -1) return null;
    Object.assign(downloads[index], changes);
    store.set('downloads', downloads);
    Object.assign(download, changes);
    return downloads[index];
}

function emitYtDlpStatus(download, status, message = '') {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-status', { id: download.id, status, message });
    }
}

function cleanupYtDlpPartialFiles(filePath) {
    if (!filePath) return;
    for (const partialPath of [`${filePath}.part`, `${filePath}.ytdl`]) {
        try { fs.rmSync(partialPath, { force: true }); } catch (_) { /* best-effort fragment cleanup */ }
    }
    try {
        const folder = path.dirname(filePath);
        const fragmentPrefix = path.basename(filePath) + '.part-Frag';
        for (const name of fs.readdirSync(folder)) {
            if (name.startsWith(fragmentPrefix)) {
                fs.rmSync(path.join(folder, name), { force: true });
            }
        }
    } catch (_) { /* No output folder or fragments to clean. */ }
}

function startYtDlpJob(download) {
    if (activeYtDlpJobs.has(download.id)) return { success: false, error: 'Video download is already running' };
    const options = download.ytDlpOptions || {};
    const cookiesFile = createYtDlpCookieJar(
        download.encryptedAuthHeaders,
        download.authHeaderOrigin,
        download.url,
        download.id
    );
    const formatId = options.formatId;
    const audioOnly = options.audioOnly === true;
    let formatStr = 'bestvideo+bestaudio/best';
    if (audioOnly) {
        formatStr = /^\d+$/.test(String(formatId || '')) ? String(formatId) : 'bestaudio/best';
    } else if (formatId) {
        const rawFormatId = String(formatId);
        const heightMatch = rawFormatId.match(/^(\d+)p$/i);
        if (heightMatch) {
            const height = parseInt(heightMatch[1], 10);
            formatStr = `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`;
        } else if (/^\d+$/.test(rawFormatId)) {
            const preferredAudioExt = options.container === 'webm' ? 'webm' : 'm4a';
            formatStr = options.hasAudio === true
                ? rawFormatId
                : `${rawFormatId}+bestaudio[ext=${preferredAudioExt}]/${rawFormatId}+bestaudio/${rawFormatId}`;
        } else if (Number.isInteger(Number(options.height)) && Number(options.height) > 0) {
            const height = Number(options.height);
            formatStr = `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`;
        } else {
            formatStr = rawFormatId;
        }
    }

    const args = [
        '-f', formatStr,
        '--no-playlist',
        '--no-warnings',
        '--newline',
        '--continue',
        '--progress-delta', '0.5',
        '--progress-template', 'download:CYBERDM_PROGRESS|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress._percent_str)s',
        '--print', 'after_move:CYBERDM_FILEPATH|%(filepath)s',
        '-o', download.savePath
    ];
    if (audioOnly) args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
    if (videoDetector.ffmpegPath && fs.existsSync(videoDetector.ffmpegPath)) {
        args.push('--ffmpeg-location', videoDetector.ffmpegPath);
    }
    if (cookiesFile) args.push('--cookies', cookiesFile);
    if (download.pageUrl) args.push('--referer', download.pageUrl);
    args.push(download.url);

    download.status = 'downloading';
    download.startedAt = new Date().toISOString();
    download.speed = 0;
    persistYtDlpDownload(download, { status: download.status, startedAt: download.startedAt, speed: 0 });

    let child;
    try {
        child = spawn(videoDetector.ytdlpPath, args);
    } catch (error) {
        if (cookiesFile) {
            try { fs.rmSync(cookiesFile, { force: true }); } catch (_) { /* best-effort cookie jar cleanup */ }
        }
        persistYtDlpDownload(download, { status: 'failed', error_message: 'Video engine error: ' + error.message, speed: 0 });
        emitYtDlpStatus(download, 'failed', error.message);
        downloadEngine.startQueuedDownloads();
        return { success: false, error: error.message };
    }

    let detectedFilename = '';
    let lastErrorOutput = '';
    let lastProgressPersistAt = 0;
    let finalized = false;
    let resolveDone;
    const job = { child, intent: null, done: new Promise(resolve => { resolveDone = resolve; }) };
    activeYtDlpJobs.set(download.id, job);

    const flushOutput = attachYtDlpOutputHandlers(child, (rawLine, streamName) => {
        const line = rawLine.trim();
        if (!line) return;
        const progress = parseYtDlpProgressLine(line);
        if (progress) {
            download.downloadedBytes = progress.downloaded;
            download.totalBytes = progress.total;
            download.speed = progress.speed;
            download.progress = progress.progress;
            download.etaSeconds = progress.eta;
            download.avgSpeed = progress.downloaded / Math.max(1, (Date.now() - new Date(download.startedAt).getTime()) / 1000);
            if (Date.now() - lastProgressPersistAt >= 1500) {
                persistYtDlpDownload(download, {
                    downloadedBytes: progress.downloaded,
                    totalBytes: progress.total,
                    speed: progress.speed,
                    avgSpeed: download.avgSpeed,
                    progress: progress.progress,
                    etaSeconds: progress.eta
                });
                lastProgressPersistAt = Date.now();
            }
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('download-progress', {
                    id: download.id,
                    progress: progress.progress,
                    downloaded: progress.downloaded,
                    total: progress.total,
                    speed: progress.speed,
                    avgSpeed: download.avgSpeed,
                    eta: progress.eta,
                    filename: download.filename,
                    threads: 1
                });
            }
            return;
        }

        const filepathMatch = line.match(/^CYBERDM_FILEPATH\|(.*)$/);
        const destMatch = line.match(/\[download\] Destination: (.+)/);
        const mergeMatch = line.match(/\[Merger\] Merging formats into "(.+)"/);
        const outputPathMatch = filepathMatch || destMatch || mergeMatch;
        if (outputPathMatch) {
            detectedFilename = outputPathMatch[1].replace(/^"|"$/g, '');
            download.savePath = detectedFilename;
            download.filename = path.basename(detectedFilename);
            persistYtDlpDownload(download, { savePath: detectedFilename, filename: download.filename });
        } else if (streamName === 'stderr' && !line.includes('CYBERDM_PROGRESS|')) {
            lastErrorOutput = line;
            log('[video-dl stderr] ' + line);
        }
    });

    const finalize = (code, spawnError = null) => {
        if (finalized) return;
        finalized = true;
        flushOutput();
        activeYtDlpJobs.delete(download.id);
        if (cookiesFile) {
            try { fs.rmSync(cookiesFile, { force: true }); } catch (_) { /* best-effort cookie jar cleanup */ }
        }

        if (job.intent === 'pause') {
            persistYtDlpDownload(download, { status: 'paused', speed: 0 });
            emitYtDlpStatus(download, 'paused');
            resolveDone();
            downloadEngine.startQueuedDownloads();
            return;
        }
        if (job.intent === 'cancel') {
            cleanupYtDlpPartialFiles(download.savePath);
            persistYtDlpDownload(download, { status: 'cancelled', speed: 0 });
            emitYtDlpStatus(download, 'cancelled');
            resolveDone();
            downloadEngine.startQueuedDownloads();
            return;
        }

        const errorMessage = spawnError
            ? 'Video engine error: ' + spawnError.message
            : (lastErrorOutput || 'Video download failed (exit code ' + code + '). Try a different quality.');
        if (code === 0 && !spawnError) {
            const finalPath = detectedFilename || download.savePath;
            const finalFilename = path.basename(finalPath);
            let finalSize = 0;
            if (fs.existsSync(finalPath)) finalSize = fs.statSync(finalPath).size;
            persistYtDlpDownload(download, {
                status: 'completed',
                progress: 100,
                speed: 0,
                completedAt: new Date().toISOString(),
                filename: finalFilename,
                savePath: finalPath,
                totalBytes: finalSize,
                downloadedBytes: finalSize
            });
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('download-complete', {
                    id: download.id,
                    filename: finalFilename,
                    savePath: finalPath,
                    totalBytes: finalSize,
                    downloadedBytes: finalSize
                });
            }
            resolveDone();
            downloadEngine.startQueuedDownloads();
            return;
        }

        persistYtDlpDownload(download, { status: 'failed', error_message: errorMessage, speed: 0 });
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-error', { id: download.id, error: errorMessage });
        }
        resolveDone();
        downloadEngine.startQueuedDownloads();
    };

    child.on('close', code => finalize(code));
    child.on('error', error => finalize(-1, error));
    return { success: true, id: download.id, filename: download.filename };
}

async function pauseYtDlpJob(id) {
    const job = activeYtDlpJobs.get(id);
    if (job) {
        job.intent = 'pause';
        job.child.kill();
        await job.done;
        return { success: true };
    }
    const downloads = store.get('downloads') || [];
    const download = downloads.find(item => item.id === id);
    if (!download?.isYtDlp) return { success: false, error: 'Video download not found' };
    if (download.status === 'paused') return { success: true };
    if (!['downloading', 'queued'].includes(download.status)) {
        return { success: false, error: 'Video download is not active' };
    }
    persistYtDlpDownload(download, { status: 'paused', speed: 0 });
    return { success: true };
}

async function cancelYtDlpJob(id) {
    const job = activeYtDlpJobs.get(id);
    if (job) {
        job.intent = 'cancel';
        job.child.kill();
        await job.done;
        return { success: true };
    }
    const downloads = store.get('downloads') || [];
    const download = downloads.find(item => item.id === id);
    if (!download?.isYtDlp) return { success: false, error: 'Video download not found' };
    if (download.status === 'completed') return { success: false, error: 'Completed video downloads cannot be cancelled' };
    if (download.status === 'cancelled') return { success: true };
    cleanupYtDlpPartialFiles(download.savePath);
    persistYtDlpDownload(download, { status: 'cancelled', speed: 0 });
    return { success: true };
}

function resumeYtDlpJob(id) {
    const downloads = store.get('downloads') || [];
    const download = downloads.find(item => item.id === id);
    if (!download?.isYtDlp || !download.ytDlpOptions) {
        return { success: false, error: 'This video job cannot be resumed; start it again from its source URL' };
    }
    if (!['paused', 'failed'].includes(download.status)) {
        return { success: false, error: 'Video download is not paused or failed' };
    }
    persistYtDlpDownload(download, { status: 'queued', speed: 0, error_message: null });
    downloadEngine.startQueuedDownloads();
    return { success: true, id, queued: download.status === 'queued' };
}

function recoverYtDlpJobs() {
    const downloads = store.get('downloads') || [];
    let changed = false;
    for (const download of downloads) {
        if (download.isYtDlp && ['downloading', 'retrying'].includes(download.status)) {
            download.status = download.ytDlpOptions ? 'paused' : 'failed';
            download.speed = 0;
            if (!download.ytDlpOptions) download.error_message = 'Restart the video download from its source URL';
            changed = true;
        }
    }
    if (changed) store.set('downloads', downloads);
}

function getTorrentClient() {
    if (!torrentClient) {
        const WebTorrent = require('webtorrent');
        torrentClient = new WebTorrent();
    }
    return torrentClient;
}

function finishTorrentJob(download, job, status, errorMessage = null) {
    if (activeTorrentJobs.get(download.id) !== job) return;
    clearInterval(job.progressInterval);
    activeTorrentJobs.delete(download.id);
    if (status !== 'paused') torrentJobsByDownload.delete(download.id);
    const changes = { status, speed: 0, errorMessage };
    if (status === 'completed') {
        changes.progress = 100;
        changes.completedAt = new Date().toISOString();
        changes.downloadedBytes = job.torrent.length;
        changes.totalBytes = job.torrent.length;
    }
    if (job.torrent.infoHash) changes.infoHash = job.torrent.infoHash;
    if (job.torrent.name) changes.filename = job.torrent.name;
    persistYtDlpDownload(download, changes);
    emitYtDlpStatus(download, status, errorMessage || '');
    if (mainWindow && !mainWindow.isDestroyed() && status === 'completed') {
        mainWindow.webContents.send('download-complete', {
            id: download.id,
            filename: job.torrent.name || download.filename,
            savePath: download.savePath,
            totalBytes: job.torrent.length,
            downloadedBytes: job.torrent.length
        });
        mainWindow.webContents.send('torrent-complete', {
            id: job.torrent.infoHash || download.id,
            downloadId: download.id,
            name: job.torrent.name || download.filename,
            path: download.savePath
        });
    }
    downloadEngine.startQueuedDownloads();
}

function startTorrentJob(download) {
    if (activeTorrentJobs.has(download.id)) return { success: false, error: 'Torrent is already running' };
    if (!download.torrentSource) return { success: false, error: 'Torrent source is missing' };

    try {
        const client = getTorrentClient();
        let torrent = torrentJobsByDownload.get(download.id) || (download.infoHash
            ? client.torrents.find(item => item.infoHash === download.infoHash)
            : null);
        const job = { torrent: null, progressInterval: null };
        if (!torrent) {
            torrent = client.add(download.torrentSource, { path: download.savePath });
        }
        job.torrent = torrent;
        activeTorrentJobs.set(download.id, job);
        torrentJobsByDownload.set(download.id, torrent);
        if (torrent.paused) torrent.resume();
        persistYtDlpDownload(download, {
            status: 'downloading', speed: torrent.downloadSpeed || 0,
            infoHash: torrent.infoHash || download.infoHash || null,
            filename: torrent.name || download.filename
        });

        const reportProgress = () => {
            if (activeTorrentJobs.get(download.id) !== job) return;
            const progress = Number(torrent.progress) || 0;
            const downloaded = Number(torrent.downloaded) || 0;
            const total = Number(torrent.length) || 0;
            const speed = Number(torrent.downloadSpeed) || 0;
            persistYtDlpDownload(download, {
                filename: torrent.name || download.filename,
                infoHash: torrent.infoHash || download.infoHash || null,
                progress: Math.round(progress * 1000) / 10,
                downloadedBytes: downloaded, totalBytes: total, speed,
                peers: torrent.numPeers || 0
            });
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('download-progress', {
                    id: download.id,
                    filename: torrent.name || download.filename,
                    progress: Math.round(progress * 1000) / 10,
                    downloaded, total, speed,
                    eta: Number.isFinite(torrent.timeRemaining) ? torrent.timeRemaining / 1000 : null,
                    threads: torrent.numPeers || 0
                });
                mainWindow.webContents.send('torrent-progress', {
                    id: torrent.infoHash || download.id,
                    downloadId: download.id,
                    name: torrent.name || download.filename,
                    progress: Math.round(progress * 100),
                    downloadSpeed: speed,
                    peers: torrent.numPeers || 0,
                    timeRemaining: torrent.timeRemaining,
                    downloaded, total
                });
            }
        };
        const onReady = () => {
            if (activeTorrentJobs.get(download.id) !== job) return;
            persistYtDlpDownload(download, {
                status: 'downloading', filename: torrent.name || download.filename,
                infoHash: torrent.infoHash, totalBytes: torrent.length || 0
            });
            reportProgress();
            if (!job.progressInterval) job.progressInterval = setInterval(reportProgress, 1000);
        };
        torrent.once('ready', onReady);
        if (torrent.ready) onReady();
        torrent.once('done', () => finishTorrentJob(download, job, 'completed'));
        torrent.on('error', error => finishTorrentJob(download, job, 'failed', error.message));
        return { success: true, id: download.id, infoHash: torrent.infoHash || null };
    } catch (error) {
        persistYtDlpDownload(download, { status: 'failed', errorMessage: error.message, speed: 0 });
        emitYtDlpStatus(download, 'failed', error.message);
        downloadEngine.startQueuedDownloads();
        return { success: false, error: error.message };
    }
}

function pauseTorrentJob(id) {
    const download = downloadEngine.getDownload(id);
    if (!download?.isTorrent) return { success: false, error: 'Torrent not found' };
    const job = activeTorrentJobs.get(id);
    if (job) {
        job.torrent.pause();
        finishTorrentJob(download, job, 'paused');
        return { success: true };
    }
    if (download.status === 'queued') {
        persistYtDlpDownload(download, { status: 'paused', speed: 0 });
        return { success: true };
    }
    return download.status === 'paused'
        ? { success: true }
        : { success: false, error: 'Torrent is not active' };
}

function resumeTorrentJob(id) {
    const download = downloadEngine.getDownload(id);
    if (!download?.isTorrent || !['paused', 'failed'].includes(download.status)) {
        return { success: false, error: 'Torrent is not paused or failed' };
    }
    persistYtDlpDownload(download, { status: 'queued', speed: 0, errorMessage: null });
    downloadEngine.startQueuedDownloads();
    return { success: true, id, queued: download.status === 'queued' };
}

function cancelTorrentJob(id) {
    const download = downloadEngine.getDownload(id);
    if (!download?.isTorrent) return { success: false, error: 'Torrent not found' };
    const job = activeTorrentJobs.get(id);
    if (job) {
        clearInterval(job.progressInterval);
        activeTorrentJobs.delete(id);
        torrentJobsByDownload.delete(id);
        try { job.torrent.destroy(); } catch (_) { /* best-effort torrent cleanup */ }
        persistYtDlpDownload(download, { status: 'cancelled', speed: 0 });
        emitYtDlpStatus(download, 'cancelled');
        downloadEngine.startQueuedDownloads();
        return { success: true };
    }
    persistYtDlpDownload(download, { status: 'cancelled', speed: 0 });
    return { success: true };
}

function setupIPC() {
    ipcMain.handle('app:open-external', (event, url) => {
        shell.openExternal(url);
        return { success: true };
    });

    ipcMain.handle('download:start', async (event, { url, savePath, options }) => {
        console.log('[DEBUG] Download start requested:', { url, savePath, options });
        try {
            // Get settings and file info first
            const settings = store.get('settings');
            let fileInfo;

            try {
                fileInfo = await downloadEngine.getFileInfo(url);
                console.log('[DEBUG] File info received:', fileInfo);
            } catch (error) {
                console.error('[DEBUG] Failed to get file info:', error);
                return { success: false, error: error.message };
            }

            // Determine the target file path
            const filename = options.filename || fileInfo.filename;
            const targetPath = savePath || settings.downloadPath || DOWNLOADS_PATH;
            const fullFilePath = path.join(targetPath, filename);

            // Check for file conflict
            const conflictResult = await fileConflictManager.resolveConflict(fullFilePath, settings);

            // If conflict detected and action is 'ask', return conflict info
            if (conflictResult.action === 'ask') {
                return {
                    success: false,
                    conflict: {
                        filePath: fullFilePath,
                        filename: filename,
                        existingSize: conflictResult.existingSize,
                        existingDate: conflictResult.existingDate,
                        suggestedName: conflictResult.suggestedName
                    }
                };
            }

            // If action is 'skip', don't start download
            if (conflictResult.action === 'skip') {
                return { success: false, error: 'Download skipped - file already exists', skipped: true };
            }

            // Prepare download options
            const downloadOptions = {
                ...options,
                filename: conflictResult.renamed ? path.basename(conflictResult.filePath) : filename
            };

            // If we need to use a renamed path, adjust savePath
            const downloadSavePath = conflictResult.renamed ? path.dirname(conflictResult.filePath) : targetPath;

            // Start the download
            console.log('[DEBUG] Starting download with path:', downloadSavePath, 'options:', downloadOptions);
            const download = await downloadEngine.startDownloadWithInfo(url, downloadSavePath, downloadOptions, fileInfo);
            console.log('[DEBUG] Download started:', download);
            return { success: true, download };
        } catch (error) {
            console.error('[DEBUG] Download start failed:', error);
            return { success: false, error: error.message };
        }
    });

    // File conflict check
    ipcMain.handle('file:check-conflict', async (event, filePath) => {
        const settings = store.get('settings');
        const result = await fileConflictManager.resolveConflict(filePath, settings);
        return result;
    });

    ipcMain.handle('file:generate-name', (event, filePath) => {
        return fileConflictManager.generateUniqueFilename(filePath);
    });

    ipcMain.handle('file:get-stats', (event, filePath) => {
        return fileConflictManager.getFileStats(filePath);
    });

    ipcMain.handle('download:pause', async (event, id) => {
        if (downloadEngine.getDownload(id)?.isTorrent) return pauseTorrentJob(id);
        if (downloadEngine.getDownload(id)?.isYtDlp) return pauseYtDlpJob(id);
        await downloadEngine.pauseDownload(id);
        return { success: true };
    });

    ipcMain.handle('download:resume', (event, id) => {
        if (downloadEngine.getDownload(id)?.isTorrent) return resumeTorrentJob(id);
        if (downloadEngine.getDownload(id)?.isYtDlp) return resumeYtDlpJob(id);
        downloadEngine.resumeDownload(id);
        return { success: true };
    });

    ipcMain.handle('download:cancel', async (event, id) => {
        if (downloadEngine.getDownload(id)?.isTorrent) return cancelTorrentJob(id);
        if (downloadEngine.getDownload(id)?.isYtDlp) return cancelYtDlpJob(id);
        await downloadEngine.cancelDownload(id);
        return { success: true };
    });

    ipcMain.handle('download:delete', async (event, id) => {
        if (downloadEngine.getDownload(id)?.isTorrent) cancelTorrentJob(id);
        if (downloadEngine.getDownload(id)?.isYtDlp) await cancelYtDlpJob(id);
        await downloadEngine.deleteDownload(id);
        return { success: true };
    });

    ipcMain.handle('download:get-all', (event, status) => downloadEngine.getDownloads(status));
    ipcMain.handle('download:get', (event, id) => downloadEngine.getDownload(id));
    ipcMain.handle('url:check-status', (_event, url) => downloadEngine.urlRefreshManager.checkUrlStatus(url));
    ipcMain.handle('download:clear-history', () => { downloadEngine.clearHistory(); return { success: true }; });
    ipcMain.handle('queue:start', () => downloadEngine.startQueue());
    ipcMain.handle('queue:stop', () => downloadEngine.stopQueue());
    ipcMain.handle('queue:get', () => downloadEngine.getQueue());
    ipcMain.handle('queue:reorder', (_event, ids) => downloadEngine.reorderQueue(ids));

    ipcMain.handle('download:open-file', (event, id) => {
        const downloads = store.get('downloads') || [];
        const download = downloads.find(d => d.id === id);
        if (download && download.savePath && fs.existsSync(download.savePath)) {
            shell.openPath(download.savePath);
            return { success: true };
        }
        return { success: false, error: 'File not found' };
    });

    ipcMain.handle('download:show-in-folder', (event, id) => {
        const downloads = store.get('downloads') || [];
        const download = downloads.find(d => d.id === id);
        if (download && download.savePath) {
            if (fs.existsSync(download.savePath)) {
                shell.showItemInFolder(download.savePath);
                return { success: true };
            } else {
                // Open parent folder if file doesn't exist
                shell.openPath(path.dirname(download.savePath));
                return { success: true, fileNotFound: true };
            }
        }
        return { success: false, error: 'Download not found' };
    });

    // ========== VIDEO DETECTION IPC HANDLERS ==========
    ipcMain.handle('video:is-video-url', (event, url) => {
        return { isVideo: videoDetector.isVideoUrl(url) };
    });

    ipcMain.handle('video:get-info', async (_event, request) => {
        const url = typeof request === 'string' ? request : request?.url;
        let cookiesFile = null;
        try {
            if (!url) return { success: false, error: 'Video URL is required' };
            cookiesFile = createYtDlpCookieJar(
                request?.encryptedAuthHeaders,
                request?.authHeaderOrigin,
                url,
                uuidv4()
            );
            return await videoDetector.getVideoInfo(url, cookiesFile, request?.pageUrl);
        } catch (err) {
            log('Video metadata lookup failed: ' + err.message);
            return { success: false, error: err.message.replace(/yt-dlp/gi, 'video engine') };
        } finally {
            if (cookiesFile) {
                try { fs.rmSync(cookiesFile, { force: true }); } catch (_) { /* best-effort cookie jar cleanup */ }
            }
        }
    });

    ipcMain.handle('video:download', async (event, data) => {
        const { url, formatId, savePath, filename, title, container, audioOnly, hasAudio, height, encryptedAuthHeaders, authHeaderOrigin, pageUrl, extensionRequestId: browserRequestId } = data;
        const duplicateResult = reuseDownloadBySource(url);
        if (duplicateResult) return duplicateResult;
        log('video:download — format: ' + formatId + ' audioOnly: ' + audioOnly);

        const settings = store.get('settings') || {};
        const basePath = savePath || settings.downloadPath || DOWNLOADS_PATH;
        const videoDir = path.join(basePath, 'Videos');
        if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });

        const outputName = typeof filename === 'string' && filename.trim()
            ? downloadEngine.sanitizeFilename(filename.trim())
            : '%(title)s.%(ext)s';
        const outputPath = path.join(videoDir, outputName);
        const id = uuidv4();
        try {
            const download = {
                id, url, originalUrl: url,
                filename: downloadEngine.sanitizeFilename(title || filename || 'Video'),
                savePath: outputPath,
                totalBytes: 0, downloadedBytes: 0,
                status: 'queued', progress: 0, speed: 0,
                category: audioOnly ? 'audio' : 'video',
                createdAt: new Date().toISOString(),
                isYtDlp: true,
                pageUrl: typeof pageUrl === 'string' ? pageUrl : undefined,
                extensionRequestId: typeof browserRequestId === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(browserRequestId) ? browserRequestId : null,
                encryptedAuthHeaders: encryptedAuthHeaders || null,
                authHeaderOrigin: authHeaderOrigin || null,
                ytDlpOptions: {
                    formatId: String(formatId || ''),
                    audioOnly: audioOnly === true,
                    hasAudio: hasAudio === true,
                    height: Number.isFinite(Number(height)) ? Number(height) : null,
                    container: typeof container === 'string' ? container : null
                }
            };

            const downloads = store.get('downloads') || [];
            downloads.unshift(download);
            store.set('downloads', downloads);

            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('download-started', download);
            }

            downloadEngine.startQueuedDownloads();
            return { success: true, id, queued: download.status === 'queued' };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // ========== YT-DLP INTEGRATION ==========
    const ytDlpPath = app.isPackaged
        ? path.join(process.resourcesPath, 'tools', 'yt-dlp.exe')
        : path.join(__dirname, '..', 'tools', 'yt-dlp.exe');

    // Get available formats for a YouTube URL
    ipcMain.handle('youtube:get-formats', async (event, url) => {
        log('youtube:get-formats requested for ' + url);
        return new Promise((resolve, reject) => {
            if (!fs.existsSync(ytDlpPath)) {
                return resolve({ success: false, error: 'Cyber Engine not found' });
            }

            const proc = spawn(ytDlpPath, ['-J', '--no-warnings', url]);
            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', d => stdout += d.toString());
            proc.stderr.on('data', d => stderr += d.toString());

            proc.on('close', (code) => {
                if (code !== 0) {
                    return resolve({ success: false, error: stderr || 'Failed to get formats' });
                }

                try {
                    const info = JSON.parse(stdout);
                    const formats = (info.formats || [])
                        .filter(f => f.vcodec !== 'none' || f.acodec !== 'none')
                        .map(f => {
                            const hasVideo = f.vcodec && f.vcodec !== 'none';
                            const hasAudio = f.acodec && f.acodec !== 'none';
                            let label = '';

                            if (hasVideo && hasAudio) {
                                label = `${f.height || '?'}p (${f.ext})`;
                            } else if (hasVideo) {
                                label = `${f.height || '?'}p video only (${f.ext})`;
                            } else if (hasAudio) {
                                label = `Audio ${f.abr || '?'}kbps (${f.ext})`;
                            }

                            return {
                                format_id: f.format_id,
                                label: label,
                                ext: f.ext,
                                height: f.height || 0,
                                width: f.width || 0,
                                filesize: f.filesize || f.filesize_approx || 0,
                                vcodec: f.vcodec,
                                acodec: f.acodec,
                                abr: f.abr || 0,
                                hasVideo,
                                hasAudio,
                                type: hasVideo ? 'video' : 'audio'
                            };
                        })
                        .filter(f => f.label);

                    // Sort: video+audio first, then by height descending
                    formats.sort((a, b) => {
                        if (a.hasVideo && a.hasAudio && !(b.hasVideo && b.hasAudio)) return -1;
                        if (!(a.hasVideo && a.hasAudio) && b.hasVideo && b.hasAudio) return 1;
                        if (a.hasVideo && !b.hasVideo) return -1;
                        if (!a.hasVideo && b.hasVideo) return 1;
                        return (b.height || b.abr) - (a.height || a.abr);
                    });

                    resolve({
                        success: true,
                        title: info.title || 'YouTube Video',
                        thumbnail: info.thumbnail,
                        duration: info.duration,
                        formats
                    });
                } catch (e) {
                    resolve({ success: false, error: 'Failed to parse video info' });
                }
            });

            // Timeout after 30s
            setTimeout(() => { proc.kill(); }, 30000);
        });
    });

    // Keep the legacy YouTube IPC on the same resumable job path as video downloads.
    ipcMain.handle('youtube:download', async (_event, url, formatId, customFilename) => {
        const duplicateResult = reuseDownloadBySource(url);
        if (duplicateResult) return duplicateResult;
        const settings = store.get('settings') || {};
        const videoDir = path.join(settings.downloadPath || DOWNLOADS_PATH, 'Videos');
        if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
        const audioOnly = ['audio', 'mp3', 'bestaudio'].includes(String(formatId).toLowerCase());
        const normalizedFormatId = audioOnly ? 'bestaudio' : String(formatId || 'best');
        const outputPath = path.join(videoDir, customFilename || '%(title)s.%(ext)s');
        const download = {
            id: uuidv4(),
            url,
            originalUrl: url,
            filename: customFilename || 'YouTube Video',
            savePath: outputPath,
            totalBytes: 0,
            downloadedBytes: 0,
            status: 'queued',
            progress: 0,
            speed: 0,
            category: audioOnly ? 'audio' : 'video',
            createdAt: new Date().toISOString(),
            isYtDlp: true,
            ytDlpOptions: { formatId: normalizedFormatId, audioOnly, hasAudio: false, height: null }
        };
        const downloads = store.get('downloads') || [];
        downloads.unshift(download);
        store.set('downloads', downloads);
        downloadEngine.startQueuedDownloads();
        return { success: true, id: download.id, queued: download.status === 'queued' };
    });

    ipcMain.handle('dialog:save-file', async (_event, defaultName) => {
        const safeName = typeof defaultName === 'string' ? path.basename(defaultName) : 'download';
        return dialog.showSaveDialog(mainWindow, {
            defaultPath: path.join(downloadEngine.getSettings().downloadPath || DOWNLOADS_PATH, safeName)
        });
    });

    ipcMain.handle('dialog:select-folder', async () => {
        const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
        return result.filePaths[0];
    });

    // Open default download folder
    ipcMain.handle('app:open-download-folder', async () => {
        const settings = store.get('settings');
        const downloadPath = settings.downloadPath || DOWNLOADS_PATH;
        if (fs.existsSync(downloadPath)) {
            shell.openPath(downloadPath);
            return { success: true };
        }
        return { success: false, error: 'Download folder does not exist' };
    });

    // Open extension folder
    ipcMain.handle('app:open-extension-folder', () => {
        const extensionPath = path.join(__dirname, '..', 'extension');
        if (fs.existsSync(extensionPath)) {
            shell.openPath(extensionPath);
            return { success: true };
        }
        return { success: false, error: 'Extension folder not found' };
    });

    // Open the default download folder
    ipcMain.handle('app:open-downloads-folder', () => {
        const settings = store.get('settings');
        const downloadPath = settings?.downloadPath || DOWNLOADS_PATH;
        shell.openPath(downloadPath);
        return { success: true };
    });

    ipcMain.handle('settings:get', () => downloadEngine.getSettings());
    ipcMain.handle('settings:save', (event, settings) => {
        downloadEngine.updateSettings(settings);
        return { success: true };
    });
    ipcMain.handle('bandwidth:get-profiles', () => getBandwidthProfiles());
    ipcMain.handle('bandwidth:set-profiles', (event, profiles) => {
        if (!Array.isArray(profiles) || profiles.length > 32) {
            return { success: false, error: 'Invalid bandwidth profiles' };
        }
        setBandwidthProfiles(profiles);
        return { success: true };
    });

    ipcMain.on('window:minimize', () => {
        const settings = store.get('settings');
        if (settings.minimizeToTray !== false && tray) {
            mainWindow?.hide();
        } else {
            mainWindow?.minimize();
        }
    });
    ipcMain.on('window:maximize', () => {
        if (mainWindow?.isMaximized()) mainWindow.unmaximize();
        else mainWindow?.maximize();
    });
    ipcMain.on('window:close', () => {
        const settings = store.get('settings');
        if (settings.minimizeToTray !== false && tray) {
            mainWindow?.hide();
        } else {
            mainWindow?.close();
        }
    });
    ipcMain.on('app:quit', () => {
        isQuitting = true;
        app.quit();
    });

    // Onboarding complete
    ipcMain.on('app:finish-onboarding', () => {
        store.set('firstRun', false);
        if (onboardingWindow && !onboardingWindow.isDestroyed()) {
            onboardingWindow.close();
            onboardingWindow = null;
        }
        if (!mainWindow || mainWindow.isDestroyed()) {
            createMainWindow();
        }
    });

    // Clipboard operations
    ipcMain.handle('clipboard:start-monitor', () => {
        if (clipboardMonitor) {
            clipboardMonitor.start();
            return { success: true };
        }
        return { success: false };
    });

    ipcMain.handle('clipboard:stop-monitor', () => {
        if (clipboardMonitor) {
            clipboardMonitor.stop();
            return { success: true };
        }
        return { success: false };
    });

    ipcMain.handle('clipboard:get-url-info', async (event, url) => {
        if (clipboardMonitor) {
            return await clipboardMonitor.getUrlInfo(url);
        }
        return { success: false };
    });

    ipcMain.handle('clipboard:clear-pending', () => {
        if (clipboardMonitor) {
            clipboardMonitor.clearPending();
        }
        return { success: true };
    });


    ipcMain.handle('update:check', () => updateChecker.checkForUpdates());

    // ========== MAYA AI SYSTEM ==========
    ipcMain.handle('ai:set-key', (event, key) => {
        store.set('geminiApiKey', key);
        return { success: true };
    });

    ipcMain.handle('ai:get-key', () => {
        const key = store.get('geminiApiKey') || '';
        return { hasKey: !!key, key: key ? key.substring(0, 6) + '...' : '' };
    });

    ipcMain.handle('ai:chat', async (event, message) => {
        const apiKey = store.get('geminiApiKey');
        if (!apiKey) return { success: false, error: 'Please set your Gemini API key in Settings first! 💜' };

        try {
            const chatHistory = store.get('mayaChatHistory') || [];
            chatHistory.push({ role: 'user', parts: [{ text: message }] });
            // Keep last 20 messages for context
            if (chatHistory.length > 20) chatHistory.splice(0, chatHistory.length - 20);

            const systemPrompt = cdmConfig.maya?.personality || 'You are Maya, a helpful and sweet AI assistant.';

            const requestBody = {
                contents: chatHistory,
                systemInstruction: { parts: [{ text: systemPrompt }] },
                generationConfig: { maxOutputTokens: 300 }
            };

            const response = await new Promise((resolve, reject) => {
                const postData = JSON.stringify(requestBody);
                const req = https.request({
                    hostname: 'generativelanguage.googleapis.com',
                    path: `/v1beta/models/${MAYA_MODEL}:generateContent?key=${apiKey}`,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
                    timeout: 15000
                }, (res) => {
                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => {
                        try { resolve(JSON.parse(body)); }
                        catch (e) { reject(new Error('Invalid Gemini response')); }
                    });
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
                req.write(postData);
                req.end();
            });

            if (response.error) {
                return { success: false, error: response.error.message || 'Gemini API error' };
            }

            const reply = response.candidates?.[0]?.content?.parts?.[0]?.text || 'Hmm, I couldn\'t think of a response... 💭';
            chatHistory.push({ role: 'model', parts: [{ text: reply }] });
            store.set('mayaChatHistory', chatHistory);

            return { success: true, reply };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('ai:clear-history', () => {
        store.set('mayaChatHistory', []);
        return { success: true };
    });

    ipcMain.handle('ai:get-greeting', () => {
        return { greeting: cdmConfig.maya?.greeting || 'Hey! I\'m Maya 💜' };
    });

    ipcMain.handle('ai:get-download-phrase', () => {
        const phrases = cdmConfig.maya?.download_phrases || ['Download complete!'];
        return { phrase: phrases[Math.floor(Math.random() * phrases.length)] };
    });

    ipcMain.handle('ai:search-movies', async (event, query) => {
        const apiKey = store.get('geminiApiKey');
        if (!apiKey) return { success: false, error: 'Set your Gemini API key first!' };

        try {
            const prompt = `User wants to find movies/shows: "${query}". 
            Give a list of 5-8 recommendations with: title, year, a short sweet description (1 line), and a download search term. 
            Format as JSON array: [{"title":"...","year":"...","desc":"...","searchTerm":"..."}]. 
            Be sweet and playful in descriptions. Only respond with valid JSON array, no markdown.`;

            const requestBody = {
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                systemInstruction: { parts: [{ text: cdmConfig.maya?.personality || '' }] },
                generationConfig: { maxOutputTokens: 800 }
            };

            const response = await new Promise((resolve, reject) => {
                const postData = JSON.stringify(requestBody);
                const req = https.request({
                    hostname: 'generativelanguage.googleapis.com',
                    path: `/v1beta/models/${MAYA_MODEL}:generateContent?key=${apiKey}`,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
                    timeout: 15000
                }, (res) => {
                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => {
                        try { resolve(JSON.parse(body)); }
                        catch (e) { reject(new Error('Invalid response')); }
                    });
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
                req.write(postData);
                req.end();
            });

            const reply = response.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
            try {
                const movies = JSON.parse(reply.replace(/```json\n?/g, '').replace(/```\n?/g, ''));
                return { success: true, movies };
            } catch (e) {
                return { success: true, movies: [], raw: reply };
            }
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // TTS via Web Speech (handled in renderer) — we just provide config
    ipcMain.handle('ai:get-tts-config', () => {
        return { engine: 'webSpeech', voiceName: 'Google UK English Female', rate: 1.0, pitch: 1.1 };
    });

    // ========== TORRENT SYSTEM ==========
    ipcMain.handle('torrent:add', async (_event, magnetOrUrl) => {
        try {
            if (typeof magnetOrUrl !== 'string' || !/^(magnet:|https?:\/\/)/i.test(magnetOrUrl.trim())) {
                return { success: false, error: 'Enter a magnet link or torrent URL' };
            }
            const settings = store.get('settings') || {};
            const id = uuidv4();
            const download = {
                id, url: magnetOrUrl, originalUrl: magnetOrUrl,
                torrentSource: magnetOrUrl,
                filename: 'Torrent metadata',
                savePath: settings.downloadPath || DOWNLOADS_PATH,
                totalBytes: 0, downloadedBytes: 0,
                status: 'queued', progress: 0, speed: 0,
                category: 'torrent', isTorrent: true,
                createdAt: new Date().toISOString()
            };
            const downloads = store.get('downloads') || [];
            downloads.unshift(download);
            store.set('downloads', downloads);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('download-started', download);
            }
            downloadEngine.startQueuedDownloads();
            return { success: true, id, queued: download.status === 'queued' };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('torrent:get-status', () => {
        return {
            torrents: (store.get('downloads') || []).filter(download => download.isTorrent).map(download => ({
                id: download.infoHash || download.id,
                downloadId: download.id,
                name: download.filename,
                progress: Math.round(Number(download.progress) || 0),
                downloadSpeed: download.speed || 0,
                peers: download.peers || 0,
                done: download.status === 'completed',
                status: download.status
            }))
        };
    });

    ipcMain.handle('torrent:remove', (_event, torrentId) => {
        const download = (store.get('downloads') || []).find(item =>
            item.isTorrent && (item.id === torrentId || item.infoHash === torrentId)
        );
        return download ? cancelTorrentJob(download.id) : { success: false, error: 'Torrent not found' };
    });

    // ========== MIRROR / PROXY / FTP / SFTP / EXTRACT / CONVERT IPC ==========
    ipcMain.handle('mirror:list', () => mirrorManager.getAllMirrors());
    ipcMain.handle('mirror:add', (_event, { domain, url }) => {
        if (typeof domain !== 'string' || typeof url !== 'string') return { success: false, error: 'A domain and mirror URL are required' };
        try {
            const parsed = new URL(url);
            if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS mirrors are supported');
            mirrorManager.addMirror(domain.trim().toLowerCase(), parsed.toString());
            return { success: true };
        } catch (error) { return { success: false, error: error.message }; }
    });
    ipcMain.handle('mirror:remove', (_event, { domain, url }) => {
        if (typeof domain !== 'string' || typeof url !== 'string') return { success: false, error: 'A domain and mirror URL are required' };
        mirrorManager.removeMirror(domain.trim().toLowerCase(), url);
        return { success: true };
    });
    ipcMain.handle('proxy:test', async (event, proxyUrl) => await applyProxy(proxyUrl));
    ipcMain.handle('ftp:download', async (_event, { url, dest, opts }) => {
        const { downloadFtp } = require('./ftp-client');
        return downloadFtp(url, dest, opts);
    });
    ipcMain.handle('sftp:download', async (_event, { url, dest, opts }) => {
        const { downloadSftp } = require('./sftp-client');
        return downloadSftp(url, dest, opts);
    });
    ipcMain.handle('extract:auto', async (_event, filePath, opts) => {
        const { autoExtract } = require('./auto-extractor');
        return autoExtract(filePath, opts);
    });
    ipcMain.handle('extract:is-archive', (_event, filePath) => require('./auto-extractor').isArchive(filePath));
    ipcMain.handle('video:convert', async (_event, src, opts, progCb) => {
        const { convertVideo } = require('./video-converter');
        return convertVideo(src, opts, progCb);
    });

    // ========== STREAM GRABBER & LOGIN MANAGER IPC ==========
    ipcMain.handle('stream:list-qualities', async (_event, url) => require('./stream-grabber').listStreamQualities(url));
    ipcMain.handle('stream:grab', async (_event, { url, quality, dest, opts = {} }) => {
        try {
            const settings = store.get('settings') || {};
            const streamDir = path.join(settings.downloadPath || DOWNLOADS_PATH, 'Streams');
            const requestedPath = dest || opts.dest;
            const outputPath = requestedPath && path.extname(requestedPath)
                ? path.resolve(requestedPath)
                : path.join(path.resolve(requestedPath || streamDir), '%(title)s.%(ext)s');
            const outputDir = path.dirname(outputPath);
            if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
            const formatId = typeof quality === 'string'
                ? quality
                : String(quality?.formatId || quality?.format_id || opts.format || 'best');
            const id = uuidv4();
            const download = {
                id, url, originalUrl: url,
                filename: 'Live stream', savePath: outputPath,
                totalBytes: 0, downloadedBytes: 0,
                status: 'queued', progress: 0, speed: 0,
                category: 'stream', isYtDlp: true, isStream: true,
                createdAt: new Date().toISOString(),
                ytDlpOptions: {
                    formatId, audioOnly: false,
                    hasAudio: quality && typeof quality === 'object' ? quality.hasAudio === true : false,
                    height: quality && typeof quality === 'object' ? Number(quality.height) || null : null
                }
            };
            const downloads = store.get('downloads') || [];
            downloads.unshift(download);
            store.set('downloads', downloads);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('download-started', download);
            }
            downloadEngine.startQueuedDownloads();
            return { success: true, id, queued: download.status === 'queued' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
    ipcMain.handle('stream:cancel', (_event, id) => {
        if (!downloadEngine.getDownload(id)?.isStream) return { success: false, error: 'Stream capture not found' };
        return cancelYtDlpJob(id);
    });
}

function extensionRequestArgument(commandLine = process.argv) {
    return commandLine.find(arg => arg.startsWith('--cyberdm-request=')) ||
        commandLine.find(arg => arg.startsWith('--cyberdm-download=')) || null;
}

function readExtensionRequestId(argument) {
    if (typeof argument !== 'string' || !argument.startsWith('--cyberdm-request=')) return null;
    const requestId = argument.slice('--cyberdm-request='.length);
    return /^[a-f0-9-]{36}$/i.test(requestId) ? requestId : null;
}

function extensionRequestId(argument) {
    const requestId = readExtensionRequestId(argument);
    if (requestId) return requestId;
    if (typeof argument === 'string' && argument.startsWith('--cyberdm-download=')) {
        try {
            return JSON.parse(Buffer.from(argument.slice('--cyberdm-download='.length), 'base64').toString('utf8')).requestId;
        } catch (_) {}
    }
    return null;
}

function readExtensionRequest(argument) {
    const requestId = readExtensionRequestId(argument);
    if (requestId) {
        const requestPath = path.join(app.getPath('userData'), 'native-requests', `${requestId}.json`);
        const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
        if (request.requestId !== requestId) throw new Error('Browser request ID did not match');
        fs.rmSync(requestPath, { force: true });
        return request;
    }
    if (typeof argument === 'string' && argument.startsWith('--cyberdm-download=')) {
        return JSON.parse(Buffer.from(argument.slice('--cyberdm-download='.length), 'base64').toString('utf8'));
    }
    throw new Error('Invalid browser download request');
}

function writeExtensionRequestAck(requestId, result) {
    if (!/^[a-f0-9-]{36}$/i.test(requestId || '')) return;
    try {
        const ackDir = path.join(app.getPath('userData'), 'native-acks');
        fs.mkdirSync(ackDir, { recursive: true });
        fs.writeFileSync(path.join(ackDir, `${requestId}.json`), JSON.stringify(result));
    } catch (error) {
        log('Could not write extension acknowledgement: ' + error.message);
    }
}

function cleanupStaleExtensionHandoffs() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const directoryName of ['native-requests', 'native-acks']) {
        const directory = path.join(app.getPath('userData'), directoryName);
        try {
            if (!fs.existsSync(directory)) continue;
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
                const filePath = path.join(directory, entry.name);
                try {
                    if (fs.statSync(filePath).mtimeMs < cutoff) fs.rmSync(filePath, { force: true });
                } catch (_) {}
            }
        } catch (error) {
            log(`Could not clean stale browser handoffs in ${directoryName}: ${error.message}`);
        }
    }
}

async function handleExtensionDownloadArgument(argument) {
    if (!argument) return { success: false, error: 'Invalid browser download request' };
    const engineDeadline = Date.now() + 15000;
    while (!downloadEngine && Date.now() < engineDeadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!downloadEngine) return { success: false, error: 'Download engine is not ready' };

    let request;
    try {
        request = readExtensionRequest(argument);
    } catch (_) {
        return { success: false, error: 'Invalid browser download request' };
    }

    if (request.action === 'download-batch') {
        if (!Array.isArray(request.urls) || request.urls.length < 1 || request.urls.length > 8) {
            return { success: false, error: 'Invalid download batch' };
        }
        const results = new Array(request.urls.length);
        let nextIndex = 0;
        const worker = async () => {
            while (nextIndex < request.urls.length) {
                const index = nextIndex++;
                try {
                    results[index] = await processExtensionDownload({
                        action: 'download',
                        url: request.urls[index],
                        clientRequestId: request.clientRequestId ? `${request.clientRequestId}:${index}` : undefined,
                        pageUrl: request.pageUrl,
                        authHeaders: request.authHeadersByUrl?.[request.urls[index]],
                        authCookies: request.authCookiesByUrl?.[request.urls[index]]
                    });
                } catch (error) {
                    results[index] = { success: false, error: error.message };
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(8, request.urls.length) }, worker));
        const rejected = results
            .map((result, index) => result?.success ? null : {
                url: request.urls[index],
                requestId: request.clientRequestId ? `${request.clientRequestId}:${index}` : undefined,
                error: result?.error || 'Download was not accepted'
            })
            .filter(Boolean);
        return {
            success: true,
            totalCount: results.length,
            acceptedCount: results.length - rejected.length,
            rejectedCount: rejected.length,
            rejected
        };
    }

    if (request.action !== 'download' || typeof request.url !== 'string') {
        return { success: false, error: 'Unsupported browser request' };
    }

    return processExtensionDownload(request);
}

function normalizeBrowserAuthHeaders(headers) {
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};
    const cookie = headers.Cookie ?? headers.cookie;
    if (typeof cookie !== 'string' || !cookie || cookie.length > 32768 || /[\r\n]/.test(cookie)) return {};
    return { Cookie: cookie };
}

function normalizeBrowserCookies(cookies, url) {
    if (!Array.isArray(cookies)) return [];
    let hostname;
    try { hostname = new URL(url).hostname.toLowerCase(); } catch (_) { return []; }
    return cookies.slice(0, 256).filter(cookie => {
        if (!cookie || typeof cookie !== 'object' || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') return false;
        if (!cookie.name || /[\t\r\n;]/.test(cookie.name) || /[\t\r\n]/.test(cookie.value)) return false;
        const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
        if (!domain || !(hostname === domain || hostname.endsWith(`.${domain}`))) return false;
        if (cookie.secure && new URL(url).protocol !== 'https:') return false;
        return true;
    }).map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: String(cookie.domain),
        path: typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/',
        secure: cookie.secure === true,
        httpOnly: cookie.httpOnly === true,
        expirationDate: Math.max(0, Number(cookie.expirationDate) || 0)
    }));
}

function safeBrowserAuthFields(headers, cookies, url) {
    const authHeaders = normalizeBrowserAuthHeaders(headers);
    const authCookies = normalizeBrowserCookies(cookies, url);
    return {
        ...(Object.keys(authHeaders).length ? { authHeaders } : {}),
        ...(authCookies.length ? { authCookies } : {})
    };
}

function encryptBrowserAuthHeaders(headers, url, cookies = []) {
    if ((!headers || !Object.keys(headers).length) && !cookies.length) return null;
    if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Secure local storage is unavailable; browser cookies were not saved');
    }
    return {
        encrypted: safeStorage.encryptString(JSON.stringify({ headers: headers || {}, cookies })).toString('base64'),
        origin: new URL(url).origin
    };
}

function requestHeadersForDownload(download, url, baseHeaders) {
    const headers = { ...baseHeaders };
    if (!download?.encryptedAuthHeaders || !download.authHeaderOrigin) return headers;
    let targetOrigin;
    try { targetOrigin = new URL(url).origin; } catch (_) { return headers; }
    if (targetOrigin !== download.authHeaderOrigin) return headers;

    let authHeaders = decryptedAuthHeaders.get(download.id);
    if (!authHeaders) {
        try {
            const encrypted = Buffer.from(download.encryptedAuthHeaders, 'base64');
            authHeaders = JSON.parse(safeStorage.decryptString(encrypted));
            decryptedAuthHeaders.set(download.id, authHeaders);
        } catch (_) {
            return headers;
        }
    }
    return { ...headers, ...(authHeaders.headers || authHeaders) };
}

function createYtDlpCookieJar(encryptedAuthHeaders, authHeaderOrigin, url, requestId) {
    if (!encryptedAuthHeaders || !authHeaderOrigin || !safeStorage.isEncryptionAvailable()) return null;
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch (_) { return null; }
    if (parsedUrl.origin !== authHeaderOrigin) return null;
    try {
        const payload = JSON.parse(safeStorage.decryptString(Buffer.from(encryptedAuthHeaders, 'base64')));
        const cookies = normalizeBrowserCookies(payload.cookies, url);
        if (!cookies.length) return null;
        const rows = ['# Netscape HTTP Cookie File'];
        for (const cookie of cookies) {
            const domainCookie = String(cookie.domain).startsWith('.');
            const domain = cookie.httpOnly ? `#HttpOnly_${cookie.domain}` : cookie.domain;
            const expiry = cookie.expirationDate ? Math.floor(cookie.expirationDate) : 0;
            rows.push([
                domain,
                domainCookie ? 'TRUE' : 'FALSE',
                cookie.path,
                cookie.secure ? 'TRUE' : 'FALSE',
                String(expiry),
                cookie.name,
                cookie.value
            ].join('\t'));
        }
        const cookieFile = path.join(TEMP_PATH, `browser-cookies-${requestId}.txt`);
        fs.writeFileSync(cookieFile, `${rows.join('\n')}\n`, { mode: 0o600 });
        return cookieFile;
    } catch (_) {
        return null;
    }
}

async function processExtensionDownload(request) {
    const clientRequestId = typeof request.clientRequestId === 'string' &&
        /^[A-Za-z0-9:_-]{1,160}$/.test(request.clientRequestId)
        ? request.clientRequestId
        : null;
    if (!clientRequestId) {
        return processExtensionDownloadOnce(request).then(result => {
            if (result?.requiresQualitySelection) flushExtensionVideoRequests();
            return result;
        });
    }

    const results = store.get('extensionRequestResults') || {};
    const cached = results[clientRequestId];
    if (cached?.success) return cached;

    const existingDownload = (store.get('downloads') || []).find(item => item.extensionRequestId === clientRequestId);
    if (existingDownload) {
        const result = { success: true, queued: true, id: existingDownload.id };
        rememberExtensionRequestResult(clientRequestId, result);
        return result;
    }
    const existingVideoRequest = (store.get('pendingExtensionVideoRequests') || [])
        .find(item => item.extensionRequestId === clientRequestId);
    if (existingVideoRequest) {
        const result = { success: true, queued: true, requiresQualitySelection: true };
        rememberExtensionRequestResult(clientRequestId, result);
        return result;
    }

    if (inFlightExtensionRequests.has(clientRequestId)) return inFlightExtensionRequests.get(clientRequestId);
    const operation = processExtensionDownloadOnce({ ...request, clientRequestId }).then(result => {
        if (result?.success) {
            rememberExtensionRequestResult(clientRequestId, result);
            if (result.requiresQualitySelection) flushExtensionVideoRequests();
        }
        return result;
    }).finally(() => inFlightExtensionRequests.delete(clientRequestId));
    inFlightExtensionRequests.set(clientRequestId, operation);
    return operation;
}

function rememberExtensionRequestResult(clientRequestId, result) {
    const results = store.get('extensionRequestResults') || {};
    results[clientRequestId] = { ...result, updatedAt: Date.now() };
    const entries = Object.entries(results).sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0)).slice(0, 1000);
    store.set('extensionRequestResults', Object.fromEntries(entries));
}

async function processExtensionDownloadOnce(request) {
    let parsedUrl;
    try {
        parsedUrl = new URL(request.url);
    } catch (_) {
        return { success: false, error: 'Invalid download URL' };
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return { success: false, error: 'Only HTTP and HTTPS links are supported by browser capture' };
    }
    const duplicateResult = reuseDownloadBySource(request.url);
    if (duplicateResult) return duplicateResult;

    const authHeaders = normalizeBrowserAuthHeaders(request.authHeaders || request.authHeadersByUrl?.[request.url]);
    const authCookies = normalizeBrowserCookies(request.authCookies || request.authCookiesByUrl?.[request.url], request.url);
    const encryptedAuthHeaders = encryptBrowserAuthHeaders(authHeaders, request.url, authCookies);

    const isManifest = request.type === 'hls' || request.type === 'dash';
    if (isManifest || request.isYouTube || videoDetector?.isVideoUrl(request.url)) {
        sendExtensionVideoRequest({
            url: request.url,
            pageUrl: request.pageUrl,
            extensionRequestId: request.clientRequestId,
            encryptedAuthHeaders: encryptedAuthHeaders?.encrypted || null,
            authHeaderOrigin: encryptedAuthHeaders?.origin || null
        });
        return { success: true, queued: true, requiresQualitySelection: true };
    }

    try {
        const settings = downloadEngine.getSettings();
        const fileInfo = await downloadEngine.getFileInfo(request.url, authHeaders);
        let filename = path.basename(String(request.filename || fileInfo.filename || 'download'));
        filename = downloadEngine.sanitizeFilename(filename) || 'download';
        const categoryFolders = {
            video: 'Videos', audio: 'Music', document: 'Documents',
            software: 'Programs', archive: 'Archives', other: ''
        };
        const category = downloadEngine.detectCategory(filename, fileInfo.contentType);
        const basePath = settings.downloadPath || DOWNLOADS_PATH;
        const targetDir = path.join(basePath, categoryFolders[category] || '');
        const requestedPath = path.join(targetDir, filename);
        if (fileConflictManager.fileExists(requestedPath)) {
            filename = path.basename(fileConflictManager.generateUniqueFilename(requestedPath));
        }

        const download = await downloadEngine.startDownloadWithInfo(request.url, basePath, {
            filename,
            pageUrl: typeof request.pageUrl === 'string' ? request.pageUrl : undefined,
            extensionRequestId: request.clientRequestId,
            encryptedAuthHeaders,
            authHeaderOrigin: encryptedAuthHeaders?.origin
        }, fileInfo);
        return { success: true, queued: true, id: download.id };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function reuseDownloadBySource(sourceUrl) {
    const duplicate = findDuplicateDownload(
        store.get('downloads') || [],
        sourceUrl,
        filePath => fs.existsSync(filePath)
    );
    if (!duplicate) return null;

    if (duplicate.action === 'resume') {
        const download = duplicate.download;
        if (download.isTorrent) resumeTorrentJob(download.id);
        else if (download.isYtDlp) resumeYtDlpJob(download.id);
        else downloadEngine.resumeDownload(download.id);
    }
    return {
        success: true,
        queued: duplicate.action !== 'already-completed',
        duplicate: true,
        resumed: duplicate.action === 'resume',
        id: duplicate.download.id
    };
}

function sendExtensionVideoRequest(request) {
    const pending = store.get('pendingExtensionVideoRequests') || [];
    if (request.extensionRequestId && pending.some(item => item.extensionRequestId === request.extensionRequestId)) return;
    pending.push({ ...request, requestId: uuidv4(), createdAt: Date.now() });
    store.set('pendingExtensionVideoRequests', pending.slice(-50));
}

function flushExtensionVideoRequests() {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return;
    const pending = store.get('pendingExtensionVideoRequests') || [];
    if (!pending.length) return;
    store.set('pendingExtensionVideoRequests', []);
    for (const request of pending) mainWindow.webContents.send('show-add-dialog', request);
}

function sendNativeHostResponse(response) {
    const body = Buffer.from(JSON.stringify(response), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    fs.writeSync(1, Buffer.concat([header, body]));
    app.quit();
}

function startNativeMessagingHost() {
    let buffer = Buffer.alloc(0);
    let handled = false;
    process.stdin.on('data', (chunk) => {
        if (handled) return;
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 4) return;
        const messageLength = buffer.readUInt32LE(0);
        if (messageLength <= 0 || messageLength > 1024 * 1024) {
            handled = true;
            sendNativeHostResponse({ success: false, error: 'Invalid native message size' });
            return;
        }
        if (buffer.length < messageLength + 4) return;
        handled = true;

        let message;
        try {
            message = JSON.parse(buffer.subarray(4, 4 + messageLength).toString('utf8'));
        } catch (_) {
            sendNativeHostResponse({ success: false, error: 'Invalid native message JSON' });
            return;
        }
        const isBatch = message.action === 'download-batch';
        if (isBatch) {
            if (!Array.isArray(message.urls) || message.urls.length < 1 || message.urls.length > 8 ||
                message.urls.some(url => typeof url !== 'string' || url.length > 16384)) {
                sendNativeHostResponse({ success: false, error: 'Invalid download batch' });
                return;
            }
        } else if (message.action !== 'download' || typeof message.url !== 'string' || message.url.length > 16384) {
            sendNativeHostResponse({ success: false, error: 'Unsupported browser request' });
            return;
        }

        if (!isBatch) {
            let requestUrl;
            try {
                requestUrl = new URL(message.url);
            } catch (_) {
                sendNativeHostResponse({ success: false, error: 'Invalid download URL' });
                return;
            }
            if (!['http:', 'https:'].includes(requestUrl.protocol)) {
                sendNativeHostResponse({ success: false, error: 'Only HTTP and HTTPS links are supported' });
                return;
            }
        }

        const requestId = uuidv4();
        const clientRequestId = typeof message.requestId === 'string' &&
            /^[A-Za-z0-9:_-]{1,160}$/.test(message.requestId)
            ? message.requestId
            : null;
        const safeMessage = isBatch
            ? (() => {
                const authHeadersByUrl = {};
                const authCookiesByUrl = {};
                for (const url of message.urls) {
                    const auth = safeBrowserAuthFields(
                        message.authHeadersByUrl?.[url],
                        message.authCookiesByUrl?.[url],
                        url
                    );
                    if (auth.authHeaders) authHeadersByUrl[url] = auth.authHeaders;
                    if (auth.authCookies) authCookiesByUrl[url] = auth.authCookies;
                }
                return {
                requestId,
                ...(clientRequestId ? { clientRequestId } : {}),
                action: 'download-batch',
                urls: message.urls.slice(0, 8),
                pageUrl: typeof message.pageUrl === 'string' ? message.pageUrl.slice(0, 4096) : '',
                ...(Object.keys(authHeadersByUrl).length ? { authHeadersByUrl } : {}),
                ...(Object.keys(authCookiesByUrl).length ? { authCookiesByUrl } : {})
                };
            })()
            : {
                requestId,
                ...(clientRequestId ? { clientRequestId } : {}),
                action: 'download',
                url: message.url,
                filename: typeof message.filename === 'string' ? message.filename.slice(0, 255) : '',
                pageUrl: typeof message.pageUrl === 'string' ? message.pageUrl.slice(0, 4096) : '',
                isYouTube: message.isYouTube === true,
                type: ['video', 'audio', 'hls', 'dash'].includes(message.type) ? message.type : '',
                ...safeBrowserAuthFields(message.authHeaders, message.authCookies, message.url)
            };
        const requestDir = path.join(app.getPath('userData'), 'native-requests');
        const requestPath = path.join(requestDir, `${requestId}.json`);
        try {
            fs.mkdirSync(requestDir, { recursive: true });
            fs.writeFileSync(requestPath, JSON.stringify(safeMessage), 'utf8');
        } catch (error) {
            sendNativeHostResponse({ success: false, error: 'Could not save browser request: ' + error.message });
            return;
        }
        const args = app.isPackaged
            ? [`--cyberdm-request=${requestId}`]
            : [app.getAppPath(), `--cyberdm-request=${requestId}`];
        const child = spawn(process.execPath, args, {
            cwd: app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(),
            detached: true,
            stdio: 'ignore',
            windowsHide: true
        });
        let replied = false;
        const finish = (response) => {
            if (replied) return;
            replied = true;
            clearInterval(ackPoll);
            sendNativeHostResponse(response);
        };
        const ackPath = path.join(app.getPath('userData'), 'native-acks', `${requestId}.json`);
        const startedAt = Date.now();
        const ackPoll = setInterval(() => {
            if (fs.existsSync(ackPath)) {
                try {
                    const response = JSON.parse(fs.readFileSync(ackPath, 'utf8'));
                    fs.rmSync(ackPath, { force: true });
                    finish(response);
                } catch (_) {
                    finish({ success: false, error: 'Invalid desktop acknowledgement' });
                }
            } else if (Date.now() - startedAt > 40000) {
                fs.rmSync(requestPath, { force: true });
                finish({ success: false, error: 'CyberDM did not accept the download in time' });
            }
        }, 100);
        child.once('error', (error) => {
            fs.rmSync(requestPath, { force: true });
            finish({ success: false, error: error.message });
        });
    });
    process.stdin.on('end', () => {
        if (!handled) sendNativeHostResponse({ success: false, error: 'No browser request received' });
    });
    process.stdin.resume();
}


app.whenReady().then(() => {
    if (nativeMessagingHostMode) {
        startNativeMessagingHost();
        return;
    }
    if (!hasSingleInstanceLock) return;

    log('App ready triggered');
    try {
        cleanupStaleExtensionHandoffs();
        downloadEngine = new SmartDownloadEngine();
        recoverYtDlpJobs();
        clipboardMonitor = new ClipboardMonitor();
        videoDetector = new VideoDetector();
        updateChecker = new UpdateChecker();
        // Recovery must run even when the user has disabled clipboard monitoring.
        recoverIncompleteDownloads(store, downloadEngine);
        downloadEngine.reconcileCompletedFileStats();

        // Init proxy manager & bandwidth scheduler
        proxyInit(store);
        mirrorManager.init(store);
        bwSchedInit(store, downloadEngine);
        bwSchedStart();

        setupIPC();
        log('Engine and IPC setup complete');

        const startupExtensionRequest = extensionRequestArgument();
        if (startupExtensionRequest) {
            handleExtensionDownloadArgument(startupExtensionRequest)
                .then(result => {
                    writeExtensionRequestAck(extensionRequestId(startupExtensionRequest), result);
                    log(result.success ? 'Browser download queued: ' + result.id : 'Browser download rejected: ' + result.error);
                })
                .catch(error => {
                    writeExtensionRequestAck(extensionRequestId(startupExtensionRequest), { success: false, error: error.message });
                    log('Startup browser handoff failed: ' + error.message);
                });
        }

        createSplashWindow();
        log('Splash (Main) creation initiated');

        const settings = store.get('settings');
        if (settings && settings.enableClipboardMonitor !== false) {
            clipboardMonitor.start();
            log('Clipboard monitor started');
        }
    } catch (err) {
        log('CRITICAL ERROR in app.whenReady: ' + err.stack);
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
