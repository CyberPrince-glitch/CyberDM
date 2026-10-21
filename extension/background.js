// CyberDM Extension - Background Service Worker
// Handles URL refresh requests from the desktop app

const NATIVE_HOST = 'com.cyberdm.native';

// Track active tabs and their videos
const tabVideos = new Map();
const pendingRefreshRequests = new Map();
const MAX_ACTIVE_NATIVE_HANDOFFS = 2;
const MAX_QUEUED_NATIVE_HANDOFFS = 6;
let activeNativeHandoffs = 0;
const nativeHandoffQueue = [];

// ========== NATIVE MESSAGING ==========

function getBrowserCookieData(url) {
    return new Promise(resolve => {
        try {
            chrome.cookies.getAll({ url }, cookies => {
                if (chrome.runtime.lastError) return resolve(null);
                const safeCookies = (cookies || []).slice(0, 256).map(cookie => ({
                    name: cookie.name,
                    value: cookie.value,
                    domain: cookie.domain,
                    path: cookie.path,
                    secure: cookie.secure === true,
                    httpOnly: cookie.httpOnly === true,
                    expirationDate: Number(cookie.expirationDate) || 0
                }));
                const header = safeCookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
                resolve(header.length <= 32768 ? { header, cookies: safeCookies } : null);
            });
        } catch (_) {
            resolve(null);
        }
    });
}

function withoutAuthHeaders(message) {
    const clean = { ...message };
    delete clean.authHeaders;
    delete clean.authHeadersByUrl;
    delete clean.authCookies;
    delete clean.authCookiesByUrl;
    return clean;
}

async function attachBrowserCookies(message) {
    const settings = await new Promise(resolve => chrome.storage.local.get(['includeBrowserCookies'], resolve));
    if (settings.includeBrowserCookies !== true) return message;

    if (message.action === 'download' && typeof message.url === 'string') {
        const cookieData = await getBrowserCookieData(message.url);
        return cookieData?.header
            ? { ...message, authHeaders: { Cookie: cookieData.header }, authCookies: cookieData.cookies }
            : message;
    }
    if (message.action === 'download-batch' && Array.isArray(message.urls)) {
        const entries = await Promise.all(message.urls.map(async url => {
            if (typeof url !== 'string') return null;
            const cookieData = await getBrowserCookieData(url);
            return cookieData?.header
                ? [url, { authHeaders: { Cookie: cookieData.header }, authCookies: cookieData.cookies }]
                : null;
        }));
        const authDataByUrl = Object.fromEntries(entries.filter(Boolean));
        if (!Object.keys(authDataByUrl).length) return message;
        const authHeadersByUrl = Object.fromEntries(Object.entries(authDataByUrl).map(([url, data]) => [url, data.authHeaders]));
        const authCookiesByUrl = Object.fromEntries(Object.entries(authDataByUrl).map(([url, data]) => [url, data.authCookies]));
        return { ...message, authHeadersByUrl, authCookiesByUrl };
    }
    return message;
}

function sendToCyberDMNow(message) {
    const requestId = message.requestId || (Number.isInteger(message.chromeDownloadId)
        ? `${chrome.runtime.id}:download:${message.chromeDownloadId}`
        : crypto.randomUUID());
    const identifiedMessage = { ...message, requestId };
    return attachBrowserCookies(identifiedMessage).then(nativeMessage => new Promise((resolve, reject) => {
        const safeForRetry = withoutAuthHeaders(identifiedMessage);
        try {
            chrome.runtime.sendNativeMessage(NATIVE_HOST, nativeMessage, response => {
                if (chrome.runtime.lastError) {
                    const error = new Error(chrome.runtime.lastError.message);
                    storeFailedNativeRequest(safeForRetry).then(() => reject(error));
                    return;
                }
                if (!response || response.success !== true) {
                    const error = new Error(response?.error || 'CyberDM did not confirm the download');
                    storeFailedNativeRequest(safeForRetry).then(() => reject(error));
                    return;
                }
                queueRejectedBatchItems(nativeMessage, response)
                    .then(() => removePendingDownload(nativeMessage.timestamp, () => {
                        stopBrowserCopyWhenAccepted(nativeMessage.chromeDownloadId, () => resolve(response));
                    }));
            });
        } catch (error) {
            storeFailedNativeRequest(safeForRetry).then(() => reject(error));
        }
    }));
}

function sendToCyberDM(message) {
    if (activeNativeHandoffs >= MAX_ACTIVE_NATIVE_HANDOFFS &&
        nativeHandoffQueue.length >= MAX_QUEUED_NATIVE_HANDOFFS) {
        return Promise.reject(new Error('CyberDM is busy. This download will stay in your browser.'));
    }

    return new Promise((resolve, reject) => {
        nativeHandoffQueue.push({ message, resolve, reject });
        drainNativeHandoffQueue();
    });
}

function drainNativeHandoffQueue() {
    while (activeNativeHandoffs < MAX_ACTIVE_NATIVE_HANDOFFS && nativeHandoffQueue.length) {
        const item = nativeHandoffQueue.shift();
        activeNativeHandoffs++;
        Promise.resolve(sendToCyberDMNow(item.message))
            .then(item.resolve, item.reject)
            .finally(() => {
                activeNativeHandoffs--;
                drainNativeHandoffQueue();
            });
    }
}

// ========== URL REFRESH SYSTEM ==========

async function refreshUrl(pageUrl, videoId, quality = null) {
    try {
        // Get the tab with this page
        const tabs = await chrome.tabs.query({ url: pageUrl });
        let tab = tabs[0];

        if (!tab) {
            // Try to find by partial URL match
            const allTabs = await chrome.tabs.query({});
            tab = allTabs.find(t => t.url && (
                t.url.includes(pageUrl) ||
                pageUrl.includes(t.url) ||
                extractVideoId(t.url) === videoId
            ));
        }

        if (!tab) {
            // Try to open the page
            tab = await chrome.tabs.create({ url: pageUrl, active: false });
            await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for page load
        }

        if (!tab) {
            throw new Error('Tab not found');
        }

        // Inject content script to scan for videos
        const videos = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: scanPageForVideos
        });

        if (videos && videos[0] && videos[0].result) {
            const foundVideos = videos[0].result;

            // Find the best matching video
            let bestVideo = null;

            if (videoId) {
                bestVideo = foundVideos.find(v => v.url && v.url.includes(videoId));
            }

            if (!bestVideo && quality) {
                // Try to find by quality
                bestVideo = foundVideos.find(v => v.quality === quality);
            }

            if (!bestVideo && foundVideos.length > 0) {
                // Get highest quality
                bestVideo = foundVideos[0];
            }

            if (bestVideo) {
                return {
                    success: true,
                    url: bestVideo.url,
                    quality: bestVideo.quality,
                    type: bestVideo.type,
                    headers: bestVideo.headers || {}
                };
            }
        }

        return { success: false, error: 'No video found' };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Function to scan page for videos (injected into page)
function scanPageForVideos() {
    const videos = [];

    // Scan video elements
    document.querySelectorAll('video').forEach(video => {
        if (video.src) {
            videos.push({
                url: video.src,
                type: 'video',
                quality: detectQuality(video)
            });
        }
        video.querySelectorAll('source').forEach(source => {
            if (source.src) {
                videos.push({
                    url: source.src,
                    type: 'video',
                    quality: source.label || detectQuality(video)
                });
            }
        });
    });

    // Scan for HLS streams (m3u8)
    document.querySelectorAll('script').forEach(script => {
        const content = script.textContent || '';
        const m3u8Matches = content.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi) || [];
        m3u8Matches.forEach(url => {
            if (!videos.some(v => v.url === url)) {
                videos.push({ url, type: 'hls', quality: 'Auto' });
            }
        });

        // Scan for DASH streams (mpd)
        const mpdMatches = content.match(/https?:\/\/[^\s"'<>]+\.mpd[^\s"'<>]*/gi) || [];
        mpdMatches.forEach(url => {
            if (!videos.some(v => v.url === url)) {
                videos.push({ url, type: 'dash', quality: 'Auto' });
            }
        });

        // Scan for direct video URLs
        const mp4Matches = content.match(/https?:\/\/[^\s"'<>]+\.(mp4|webm|mkv)[^\s"'<>]*/gi) || [];
        mp4Matches.forEach(url => {
            if (!videos.some(v => v.url === url)) {
                videos.push({ url, type: 'video', quality: 'Direct' });
            }
        });
    });

    // YouTube specific detection
    if (location.hostname.includes('youtube.com')) {
        // Try to get from ytInitialPlayerResponse
        try {
            const ytData = document.querySelector('script');
            if (ytData && ytData.textContent) {
                const ytMatch = ytData.textContent.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
                if (ytMatch) {
                    const playerResponse = JSON.parse(ytMatch[1]);
                    if (playerResponse.streamingData) {
                        // Get both formats and adaptiveFormats
                        const formats = [
                            ...(playerResponse.streamingData.formats || []),
                            ...(playerResponse.streamingData.adaptiveFormats || [])
                        ];
                        formats.forEach(fmt => {
                            if (fmt.url) {
                                videos.push({
                                    url: fmt.url,
                                    type: 'video',
                                    quality: fmt.qualityLabel || fmt.quality || 'Unknown',
                                    itag: fmt.itag
                                });
                            }
                        });
                    }
                }
            }
        } catch (e) {
            console.log('YouTube extraction error:', e);
        }
    }

    // Facebook detection
    if (location.hostname.includes('facebook.com')) {
        document.querySelectorAll('video').forEach(video => {
            if (video.src) {
                videos.push({
                    url: video.src,
                    type: 'video',
                    quality: 'HD'
                });
            }
        });
    }

    return videos;

    function detectQuality(video) {
        if (video.videoHeight) {
            if (video.videoHeight >= 2160) return '4K';
            if (video.videoHeight >= 1080) return '1080p';
            if (video.videoHeight >= 720) return '720p';
            if (video.videoHeight >= 480) return '480p';
            if (video.videoHeight >= 360) return '360p';
        }
        return 'Auto';
    }
}

function extractVideoId(url) {
    // YouTube video ID
    const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/);
    if (ytMatch) return ytMatch[1];
    return null;
}

// ========== MESSAGE HANDLING ==========

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'download') {
        sendToCyberDM(request)
            .then(() => sendResponse({ success: true }))
            .catch(err => {
                const message = err?.message || 'The desktop app did not accept the request';
                showNotification('CyberDM connection failed', message);
                sendResponse({ success: false, error: message });
            });
        return true;
    }

    if (request.action === 'refresh-url') {
        refreshUrl(request.pageUrl, request.videoId, request.quality)
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === 'getPending') {
        chrome.storage.local.get(['pendingDownloads'], (result) => {
            sendResponse({ pending: result.pendingDownloads || [] });
        });
        return true;
    }

    if (request.action === 'clearPending') {
        chrome.storage.local.set({ pendingDownloads: [] });
        sendResponse({ success: true });
        return;
    }

    if (request.action === 'removePending') {
        chrome.storage.local.get(['pendingDownloads'], (result) => {
            const pending = Array.isArray(result.pendingDownloads) ? result.pendingDownloads : [];
            chrome.storage.local.set({
                pendingDownloads: pending.filter(item => item.timestamp !== request.timestamp)
            }, () => sendResponse({ success: true }));
        });
        return true;
    }

    if (request.action === 'scanPage') {
        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            if (tabs[0]) {
                try {
                    const results = await chrome.scripting.executeScript({
                        target: { tabId: tabs[0].id },
                        func: scanPageForVideos
                    });
                    if (results && results[0]) {
                        sendResponse({ success: true, videos: results[0].result });
                    } else {
                        sendResponse({ success: false, error: 'No results' });
                    }
                } catch (err) {
                    sendResponse({ success: false, error: err.message });
                }
            } else {
                sendResponse({ success: false, error: 'No active tab' });
            }
        });
        return true;
    }
});

// ========== CONTEXT MENU ==========

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
            id: 'cyberdm-download',
            title: 'Download this link with CyberDM',
            contexts: ['link', 'video', 'audio', 'image']
        });
        chrome.contextMenus.create({
            id: 'cyberdm-selection',
            title: 'Download links in selection with CyberDM',
            contexts: ['selection']
        });
        chrome.contextMenus.create({
            id: 'cyberdm-page-links',
            title: 'Collect download links from this page',
            contexts: ['page']
        });
        chrome.contextMenus.create({
            id: 'cyberdm-grab',
            title: 'Collect media from this page',
            contexts: ['page']
        });
    });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    try {
        if (info.menuItemId === 'cyberdm-download') {
            const url = info.linkUrl || info.srcUrl || info.pageUrl;
            const result = await sendDownloadBatch([url], tab?.url || info.pageUrl || '');
            showBatchNotification(result);
        }

        if (info.menuItemId === 'cyberdm-selection') {
            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: scanSelectedLinks
            });
            const urls = results?.[0]?.result || [];
            if (!urls.length) return showNotification('No links found', 'Select one or more links or URLs, then try again.');
            showBatchNotification(await sendDownloadBatch(urls, tab.url));
        }

        if (info.menuItemId === 'cyberdm-page-links') {
            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: scanPageForDownloadLinks
            });
            const urls = results?.[0]?.result || [];
            if (!urls.length) return showNotification('No download links found', 'This page has no recognizable file links.');
            showBatchNotification(await sendDownloadBatch(urls, tab.url));
        }

        if (info.menuItemId === 'cyberdm-grab') {
            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: scanPageForVideos
            });
            const urls = (results?.[0]?.result || []).map(item => item.url).filter(Boolean);
            if (!urls.length) return showNotification('No media found', 'This page has no supported media URLs.');
            showBatchNotification(await sendDownloadBatch(urls, tab.url));
        }

    } catch (error) {
        showNotification('CyberDM action failed', error.message || 'The page could not be scanned.');
    }
});

async function sendDownloadBatch(urls, pageUrl) {
    const candidates = [...new Set((urls || []).filter(url => typeof url === 'string' && /^https?:\/\//i.test(url)))];
    const uniqueUrls = candidates.slice(0, 8);
    if (!uniqueUrls.length) return { total: 0, accepted: 0, queued: 0 };
    try {
        const response = await sendToCyberDM({ action: 'download-batch', urls: uniqueUrls, pageUrl, requestId: crypto.randomUUID() });
        return {
            total: uniqueUrls.length,
            accepted: response.acceptedCount || 0,
            queued: response.rejectedCount || 0,
            truncated: candidates.length > uniqueUrls.length
        };
    } catch (_) {
        return { total: uniqueUrls.length, accepted: 0, queued: uniqueUrls.length, truncated: candidates.length > uniqueUrls.length };
    }
}

async function storeFailedNativeRequest(message) {
    if (message?.action !== 'download-batch' || !Array.isArray(message.urls)) {
        await storePendingDownload(message);
        return;
    }
    for (const url of message.urls.slice(0, 8)) {
        const index = message.urls.indexOf(url);
        await storePendingDownload({ action: 'download', url, pageUrl: message.pageUrl || '', requestId: `${message.requestId}:${index}` });
    }
}

async function queueRejectedBatchItems(message, response) {
    if (message?.action !== 'download-batch' || !Array.isArray(response?.rejected)) return;
    for (const item of response.rejected) {
        if (typeof item?.url === 'string') {
            await storePendingDownload({ action: 'download', url: item.url, pageUrl: message.pageUrl || '', requestId: item.requestId });
        }
    }
}

function showBatchNotification(result) {
    if (!result?.total) return showNotification('No downloadable links', 'Nothing was sent to CyberDM.');
    const parts = [];
    if (result.accepted) parts.push(`${result.accepted} accepted by CyberDM`);
    if (result.queued) parts.push(`${result.queued} saved for retry`);
    if (result.truncated) parts.push('limited to the first 8 links');
    showNotification('CyberDM link collection', `${result.total} link(s): ${parts.join(', ')}`);
}

function scanSelectedLinks() {
    const urls = new Set();
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return [];
    for (let index = 0; index < selection.rangeCount; index++) {
        const fragment = selection.getRangeAt(index).cloneContents();
        fragment.querySelectorAll?.('a[href]').forEach(anchor => urls.add(anchor.href));
    }
    const textUrls = selection.toString().match(/https?:\/\/[^\s<>()"']+/gi) || [];
    textUrls.forEach(url => urls.add(url.replace(/[.,;!?]+$/, '')));
    return [...urls].filter(url => /^https?:\/\//i.test(url)).slice(0, 100);
}

function scanPageForDownloadLinks() {
    const extensions = /\.(?:7z|aac|avi|bin|csv|docx?|dmg|epub|exe|flac|flv|gz|iso|m4a|mkv|mov|mp3|mp4|msi|ogg|pdf|pptx?|rar|rpm|tar|wav|webm|wma|xlsx?|zip)(?:$|[?#])/i;
    const urls = new Set();
    document.querySelectorAll('a[href]').forEach(anchor => {
        if (extensions.test(anchor.href)) urls.add(anchor.href);
    });
    document.querySelectorAll('video, audio, source').forEach(media => {
        const src = media.currentSrc || media.src;
        if (src && !src.startsWith('blob:')) urls.add(src);
    });
    return [...urls].filter(url => /^https?:\/\//i.test(url)).slice(0, 100);
}

// ========== WEB REQUEST TRACKING ==========

const videoUrls = new Set();
const videoExtensions = ['.mp4', '.webm', '.mkv', '.avi', '.m3u8', '.mpd'];
const audioExtensions = ['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg'];

chrome.webRequest.onCompleted.addListener(
    (details) => {
        const url = details.url.toLowerCase();
        const isVideo = videoExtensions.some(ext => url.includes(ext));
        const isAudio = audioExtensions.some(ext => url.includes(ext));

        if (isVideo || isAudio) {
            videoUrls.add(details.url);
        }

        const contentType = details.responseHeaders?.find(h =>
            h.name.toLowerCase() === 'content-type'
        )?.value?.toLowerCase() || '';

        if (contentType.includes('video') || contentType.includes('audio')) {
            videoUrls.add(details.url);
        }
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders']
);

// ========== STORAGE ==========

function storePendingDownload(message) {
    return new Promise((resolve) => {
        chrome.storage.local.get(['pendingDownloads'], (result) => {
            const pending = Array.isArray(result.pendingDownloads) ? result.pendingDownloads : [];
            const url = typeof message?.url === 'string' ? message.url : '';
            if (!url) return resolve();
            const recentIndex = message.requestId
                ? pending.findIndex(item => item.requestId === message.requestId)
                : pending.findIndex(item => !item.requestId && item.url === url && Date.now() - item.timestamp < 30000);
            if (recentIndex !== -1) {
                pending[recentIndex] = {
                    ...pending[recentIndex],
                    ...message,
                    timestamp: pending[recentIndex].timestamp
                };
            } else {
                pending.push({ ...message, timestamp: Date.now() });
            }
            if (pending.length > 100) pending.splice(0, pending.length - 100);
            chrome.storage.local.set({ pendingDownloads: pending }, () => {
                showNotification('Download Queued', 'Open CyberDM to start download');
                resolve();
            });
        });
    });
}

function removePendingDownload(timestamp, callback) {
    if (!Number.isFinite(timestamp)) {
        callback?.();
        return;
    }
    chrome.storage.local.get(['pendingDownloads'], (result) => {
        const pending = Array.isArray(result.pendingDownloads) ? result.pendingDownloads : [];
        chrome.storage.local.set({
            pendingDownloads: pending.filter(item => item.timestamp !== timestamp)
        }, () => callback?.());
    });
}

function stopBrowserCopyWhenAccepted(downloadId, callback) {
    if (!Number.isInteger(downloadId)) return callback?.();
    chrome.downloads.search({ id: downloadId }, (items) => {
        const item = (items || []).find(entry => entry.id === downloadId);
        if (!item || item.state !== 'in_progress') return callback?.();
        chrome.downloads.cancel(downloadId, () => {
            chrome.downloads.erase({ id: downloadId }, () => callback?.());
        });
    });
}

function showNotification(title, message) {
    chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title: title,
        message: message
    });
}

// ========== NATIVE HOST CONNECTION FOR URL REFRESH ==========

// Listen for URL refresh requests from native app
chrome.runtime.onConnectExternal.addListener((port) => {
    port.onMessage.addListener((message) => {
        if (message.type === 'refresh-url-request') {
            refreshUrl(message.pageUrl, message.videoId, message.quality)
                .then(result => {
                    port.postMessage({ type: 'refresh-url-response', ...result });
                })
                .catch(error => {
                    port.postMessage({ type: 'refresh-url-response', success: false, error: error.message });
                });
        }
    });
});
// ========== AUTO-CAPTURE CHROME DOWNLOADS (IDM-style) ==========

// File extensions to auto-capture
const CAPTURE_EXTENSIONS = [
    // Video
    '.mp4', '.mkv', '.avi', '.webm', '.mov', '.flv', '.wmv', '.m4v', '.3gp', '.ts', '.mpg', '.mpeg',
    // Audio
    '.mp3', '.flac', '.aac', '.ogg', '.wav', '.wma', '.m4a', '.opus',
    // Archives
    '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso', '.cab',
    // Software
    '.exe', '.msi', '.dmg', '.deb', '.rpm', '.apk', '.appimage',
    // Documents
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.epub',
    // Images (large)
    '.psd', '.ai', '.svg',
    // Other
    '.torrent'
];

// URLs to never capture
const EXCLUDE_URL_PATTERNS = [
    /^chrome/i,
    /^chrome-extension/i,
    /^about:/i,
    /^blob:/i,
    /^data:/i,
    /^file:/i,
    /chrome\.google\.com\/webstore/i,
    /extensions/i
];

// Content types to skip (HTML pages, etc.)
const SKIP_CONTENT_TYPES = [
    'text/html',
    'text/xml',
    'application/xhtml+xml'
];

let autoCaptureEnabled = true;

// Load auto-capture setting
chrome.storage.local.get(['autoCaptureEnabled'], (result) => {
    autoCaptureEnabled = result.autoCaptureEnabled !== false; // Default: true
});

// Listen for setting changes
chrome.storage.onChanged.addListener((changes) => {
    if (changes.autoCaptureEnabled) {
        autoCaptureEnabled = changes.autoCaptureEnabled.newValue;
    }
});

// Listen for Chrome downloads and intercept them
chrome.downloads.onCreated.addListener((downloadItem) => {
    if (!autoCaptureEnabled) return;

    const url = downloadItem.url || '';
    const filename = downloadItem.filename || '';
    const fileSize = downloadItem.fileSize || downloadItem.totalBytes || 0;
    const mime = (downloadItem.mime || '').toLowerCase();

    // Skip if URL matches exclude patterns
    if (EXCLUDE_URL_PATTERNS.some(pattern => pattern.test(url))) return;

    // Skip HTML pages
    if (SKIP_CONTENT_TYPES.includes(mime)) return;

    // Skip very small files (< 1KB, likely not real downloads)
    if (fileSize > 0 && fileSize < 1024) return;

    // Check if it's a downloadable file type
    const urlLower = url.toLowerCase();
    const hasCapturableExtension = CAPTURE_EXTENSIONS.some(ext => urlLower.includes(ext));
    const isLargeFile = fileSize > 100 * 1024; // > 100KB
    const hasDownloadMime = mime.startsWith('application/') ||
                            mime.startsWith('video/') ||
                            mime.startsWith('audio/') ||
                            mime.includes('octet-stream') ||
                            mime.includes('zip') ||
                            mime.includes('pdf');

    // Capture if: has known extension OR large file OR download-type MIME
    if (hasCapturableExtension || isLargeFile || hasDownloadMime) {
        // Extract page URL from referrer or active tab
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const pageUrl = (tabs[0] && tabs[0].url) || downloadItem.referrer || '';

            // Send to CyberDM
            sendToCyberDM({
                action: 'download',
                url: url,
                chromeDownloadId: downloadItem.id,
                filename: filename ? filename.split(/[/\\]/).pop() : '',
                pageUrl: pageUrl,
                fileSize: fileSize,
                mime: mime
            })
            .then(() => {
                // sendToCyberDM cancels only an active browser copy after acknowledgement.
                showNotification('Download Captured', `Sent to CyberDM: ${filename ? filename.split(/[/\\]/).pop() : url.substring(0, 50)}`);
            })
            .catch(() => {
                showNotification('Download Queued', 'Open CyberDM to start download');
            });
        });
    }
});

console.log('CyberDM Extension loaded — Auto-Capture + URL Refresh enabled');
