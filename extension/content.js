// CyberDM Extension - Content Script v2.0
// Detects videos/files and shows download overlay with proper sizes & quality

(function() {
    'use strict';

    const detectedMedia = [];
    let downloadButton = null;
    let isButtonVisible = false;

    // ========== STYLES ==========
    const styles = `
        @keyframes cyberdm-pulse {
            0% { box-shadow: 0 0 0 0 rgba(93, 224, 170, .28); }
            70% { box-shadow: 0 0 0 8px rgba(93, 224, 170, 0); }
            100% { box-shadow: 0 0 0 0 rgba(93, 224, 170, 0); }
        }
        @keyframes cyberdm-shine {
            to { background-position: 200% center; }
        }
        .cyberdm-overlay-btn {
            position: absolute;
            top: 12px;
            left: 12px;
            z-index: 999999;
            background: linear-gradient(135deg, rgba(17, 40, 33, .96), rgba(9, 22, 19, .96));
            color: #ffffff;
            border: 1px solid rgba(149, 226, 191, .32);
            border-radius: 11px;
            padding: 9px 13px;
            font-family: 'Segoe UI', system-ui, sans-serif;
            font-size: 13px;
            font-weight: 650;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
            box-shadow: 0 8px 26px rgba(0,0,0,.36), inset 0 1px rgba(255,255,255,.06);
            transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
            backdrop-filter: blur(18px) saturate(140%);
            animation: cyberdm-pulse 2.8s infinite;
        }
        .cyberdm-overlay-btn:hover {
            transform: translateY(-2px) scale(1.03);
            box-shadow: 0 9px 25px rgba(48, 190, 133, .25);
            border-color: rgba(174, 255, 216, .55);
        }
        .cyberdm-overlay-btn svg { width: 18px; height: 18px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3)); }
        .cyberdm-overlay-logo { width: 19px; height: 19px; object-fit: cover; border-radius: 6px; box-shadow: 0 0 12px rgba(74, 220, 170, .18); }
        .cyberdm-badge {
            background: rgba(115, 237, 189, .13);
            border-radius: 6px;
            padding: 3px 8px;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.5px;
            border: 1px solid rgba(166, 230, 197, .18);
            box-shadow: inset 0 1px 2px rgba(255,255,255,0.1);
        }
        .cyberdm-quality-popup {
            position: absolute;
            top: 50px;
            left: 10px;
            z-index: 9999999;
            background: linear-gradient(145deg, rgba(17, 31, 28, .97), rgba(8, 17, 16, .97));
            backdrop-filter: blur(24px) saturate(150%);
            border: 1px solid rgba(139, 211, 176, .26);
            border-radius: 14px;
            padding: 13px;
            min-width: 268px;
            max-height: 350px;
            overflow-y: auto;
            box-shadow: 0 14px 42px rgba(0, 0, 0, .48), inset 0 1px rgba(255,255,255,.045);
            display: none;
        }
        .cyberdm-quality-popup.show { display: block; }
        .cyberdm-popup-title {
            color: #8de7b8;
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 10px;
            padding-bottom: 8px;
            border-bottom: 1px solid rgba(141, 231, 184, .17);
        }
        .cyberdm-quality-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 9px 12px;
            margin: 4px 0;
            background: rgba(255, 255, 255, 0.04);
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.15s ease;
            border: 1px solid transparent;
        }
        .cyberdm-quality-item:hover {
            background: rgba(80, 187, 132, .12);
            border-color: rgba(141, 231, 184, .24);
        }
        .cyberdm-quality-label {
            color: #ffffff;
            font-size: 13px;
            font-weight: 500;
        }
        .cyberdm-quality-size {
            color: #888;
            font-size: 11px;
        }
        .cyberdm-quality-item.youtube {
            background: rgba(78, 170, 125, .08);
            border: 1px solid rgba(115, 237, 189, .14);
        }
        .cyberdm-quality-item.youtube:hover {
            background: rgba(78, 170, 125, .14);
        }
        .cyberdm-quality-item.audio {
            background: rgba(56, 190, 125, .06);
        }
        .cyberdm-quality-item.audio:hover {
            background: rgba(56, 190, 125, .13);
        }
        .cyberdm-yt-note {
            color: #888;
            font-size: 10px;
            padding: 6px 8px;
            text-align: center;
            font-style: italic;
        }
    `;

    const styleSheet = document.createElement('style');
    styleSheet.textContent = styles;
    document.head.appendChild(styleSheet);

    // ========== HELPERS ==========
    function getFormatFromUrl(url) {
        try {
            const pathname = new URL(url).pathname;
            const ext = pathname.split('.').pop().toLowerCase().split('?')[0];
            if (['mp4','webm','mkv','avi','mov','flv','mp3','flac','aac','ogg','wav','m4a','opus','m3u8','mpd','ts'].includes(ext)) return ext;
        } catch (e) {}
        return '';
    }

    function getVideoQuality(video) {
        if (video.videoHeight) {
            if (video.videoHeight >= 2160) return '4K';
            if (video.videoHeight >= 1440) return '1440p';
            if (video.videoHeight >= 1080) return '1080p';
            if (video.videoHeight >= 720) return '720p';
            if (video.videoHeight >= 480) return '480p';
            if (video.videoHeight >= 360) return '360p';
            return video.videoHeight + 'p';
        }
        return '';
    }

    // ========== DETECT MEDIA ==========
    function isYouTube() {
        return location.hostname.includes('youtube.com') || location.hostname.includes('youtu.be');
    }

    async function scanForMedia() {
        detectedMedia.length = 0;

        // ----- YouTube: Don't extract blob URLs, send page URL to CyberDM -----
        if (isYouTube() && location.pathname === '/watch') {
            const title = document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent
                       || document.querySelector('h1.title')?.textContent
                       || document.title?.replace(' - YouTube', '')
                       || 'YouTube Video';

            detectedMedia.push({
                type: 'youtube',
                url: location.href,
                quality: '🎬 Download with CyberDM',
                title: title,
                pageUrl: location.href,
                isYouTube: true
            });

            updateDownloadButton();
            return;
        }

        // ----- Regular video elements -----
        const videoEls = document.querySelectorAll('video');
        for (const video of videoEls) {
            const src = video.src || video.currentSrc;
            if (src && !src.startsWith('blob:')) {
                const quality = getVideoQuality(video);
                const ext = getFormatFromUrl(src);
                detectedMedia.push({
                    type: 'video', url: src,
                    quality: quality || ext.toUpperCase() || 'Video',
                    sizeBytes: 0,
                    sizeLabel: '',
                    format: ext || 'mp4'
                });
            }
            for (const source of video.querySelectorAll('source')) {
                if (source.src && !source.src.startsWith('blob:')) {
                    detectedMedia.push({
                        type: 'video', url: source.src,
                        quality: source.label || getVideoQuality(video) || getFormatFromUrl(source.src).toUpperCase(),
                        sizeBytes: 0, sizeLabel: '',
                        format: getFormatFromUrl(source.src) || 'mp4'
                    });
                }
            }
        }

        // ----- HLS / DASH streams -----
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
            const content = script.textContent || '';
            (content.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi) || []).forEach(url => {
                if (!detectedMedia.some(v => v.url === url)) {
                    detectedMedia.push({ type: 'hls', url, quality: 'HLS Stream', format: 'm3u8' });
                }
            });
            (content.match(/https?:\/\/[^\s"'<>]+\.mpd[^\s"'<>]*/gi) || []).forEach(url => {
                if (!detectedMedia.some(v => v.url === url)) {
                    detectedMedia.push({ type: 'dash', url, quality: 'DASH Stream', format: 'mpd' });
                }
            });
        }

        // ----- Direct video/audio links -----
        const mediaExts = '.mp4,.webm,.mkv,.avi,.mov,.flv,.mp3,.flac,.aac,.ogg,.wav,.m4a,.opus';
        for (const ext of mediaExts.split(',')) {
            for (const link of document.querySelectorAll(`a[href$="${ext}"]`)) {
                if (!detectedMedia.some(v => v.url === link.href)) {
                    const isAudio = ['.mp3','.flac','.aac','.ogg','.wav','.m4a','.opus'].includes(ext);
                    detectedMedia.push({
                        type: isAudio ? 'audio' : 'video',
                        url: link.href,
                        quality: ext.replace('.','').toUpperCase() + (isAudio ? ' Audio' : ''),
                        format: ext.replace('.',''),
                        sizeBytes: 0, sizeLabel: ''
                    });
                }
            }
        }

        // ----- Audio elements -----
        for (const audio of document.querySelectorAll('audio')) {
            if (audio.src && !audio.src.startsWith('blob:')) {
                detectedMedia.push({
                    type: 'audio', url: audio.src, quality: 'Audio',
                    sizeBytes: 0, sizeLabel: ''
                });
            }
        }

        updateDownloadButton();
    }

    // ========== DOWNLOAD BUTTON ==========
    function createDownloadButton() {
        if (downloadButton) return;

        downloadButton = document.createElement('div');
        downloadButton.innerHTML = `
            <button class="cyberdm-overlay-btn" id="cyberdm-btn">
                <img class="cyberdm-overlay-logo" src="${chrome.runtime.getURL('icons/icon-32.png')}" alt="">
                <span>CyberDM</span>
                <span class="cyberdm-badge" id="cyberdm-count">0</span>
            </button>
            <div class="cyberdm-quality-popup" id="cyberdm-popup">
                <div class="cyberdm-popup-title">📥 Download Options</div>
                <div id="cyberdm-quality-list"></div>
            </div>
        `;
        downloadButton.style.cssText = 'position:absolute;top:0;left:0;z-index:999999;';

        const btn = downloadButton.querySelector('#cyberdm-btn');
        const popup = downloadButton.querySelector('#cyberdm-popup');
        btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); popup.classList.toggle('show'); });
        document.addEventListener('click', e => { if (!downloadButton.contains(e.target)) popup.classList.remove('show'); });
    }

    function updateDownloadButton() {
        if (detectedMedia.length === 0) { hideDownloadButton(); return; }

        createDownloadButton();
        const qualityList = downloadButton.querySelector('#cyberdm-quality-list');
        const countBadge = downloadButton.querySelector('#cyberdm-count');
        qualityList.innerHTML = '';
        countBadge.textContent = detectedMedia.length;

        detectedMedia.forEach(media => {
            const item = document.createElement('div');
            const isYT = media.isYouTube;
            const isAudio = media.type === 'audio';
            item.className = `cyberdm-quality-item ${isYT ? 'youtube' : ''} ${isAudio ? 'audio' : ''}`;

            let label = media.quality || media.format?.toUpperCase() || 'Download';
            let sizeText = media.sizeLabel || (isYT ? 'Cyber Engine' : media.type.toUpperCase());

            item.innerHTML = `
                <span class="cyberdm-quality-label">${isYT ? '▶ ' : ''}${label}</span>
                <span class="cyberdm-quality-size">${sizeText}</span>
            `;
            item.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); downloadMedia(media); });
            qualityList.appendChild(item);
        });

        if (detectedMedia.some(m => m.isYouTube)) {
            const note = document.createElement('div');
            note.className = 'cyberdm-yt-note';
            note.textContent = 'Quality selection available in CyberDM app';
            qualityList.appendChild(note);
        }

        showDownloadButton();
    }

    function showDownloadButton() {
        if (!downloadButton || isButtonVisible) return;
        const video = document.querySelector('video');
        if (video) {
            const container = video.closest('.html5-video-player') || video.closest('.video-player') || video.parentElement;
            if (container) { container.style.position = 'relative'; container.appendChild(downloadButton); }
            else { document.body.appendChild(downloadButton); downloadButton.style.position = 'fixed'; }
        } else { document.body.appendChild(downloadButton); downloadButton.style.position = 'fixed'; downloadButton.style.top = '10px'; downloadButton.style.right = '10px'; downloadButton.style.left = 'auto'; }
        isButtonVisible = true;
    }

    function hideDownloadButton() {
        if (downloadButton && isButtonVisible && downloadButton.parentElement) {
            downloadButton.parentElement.removeChild(downloadButton);
        }
        isButtonVisible = false;
    }

    function downloadMedia(media) {
        // Send to background → CyberDM app
        chrome.runtime.sendMessage({
            action: 'download',
            url: media.url,
            type: media.type,
            quality: media.quality,
            pageUrl: media.pageUrl || location.href,
            title: media.title || document.title,
            isYouTube: media.isYouTube || false,
            fileSize: media.sizeBytes || 0
        }, response => {
            const runtimeError = chrome.runtime.lastError?.message;
            if (response?.success === true) {
                const popup = downloadButton.querySelector('#cyberdm-popup');
                if (popup) popup.classList.remove('show');
                return;
            }

            const popup = downloadButton.querySelector('#cyberdm-popup');
            const list = downloadButton.querySelector('#cyberdm-quality-list');
            if (!popup || !list) return;
            list.querySelector('.cyberdm-handoff-error')?.remove();
            const error = document.createElement('div');
            error.className = 'cyberdm-handoff-error';
            error.style.cssText = 'color:#ff8b8b;font-size:11px;padding:8px;line-height:1.4;';
            error.textContent = `Could not reach CyberDM: ${response?.error || runtimeError || 'No response from the desktop app'}. Check that CyberDM is open and the native host is installed.`;
            list.appendChild(error);
            popup.classList.add('show');
        });
    }

    // ========== OBSERVER ==========
    const observer = new MutationObserver(() => {
        clearTimeout(observer.timeout);
        observer.timeout = setTimeout(scanForMedia, 800);
    });

    // ========== INIT ==========
    function init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => setTimeout(scanForMedia, 1500));
        } else {
            setTimeout(scanForMedia, 1500);
        }
        observer.observe(document.body, { childList: true, subtree: true });

        // SPA navigation detection
        let lastUrl = location.href;
        new MutationObserver(() => {
            if (location.href !== lastUrl) { lastUrl = location.href; setTimeout(scanForMedia, 1500); }
        }).observe(document, { subtree: true, childList: true });
    }
    init();

    // ========== MESSAGE HANDLING ==========
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'scan') {
            scanForMedia().then(() => sendResponse({ videos: detectedMedia }));
            return true;
        }
        if (request.action === 'getVideos') {
            sendResponse({ videos: detectedMedia });
        }
    });
})();
