// CyberDM Extension popup.
document.addEventListener('DOMContentLoaded', () => {
    const urlInput = document.getElementById('url-input');
    const downloadBtn = document.getElementById('download-btn');
    const scanBtn = document.getElementById('scan-btn');
    const statusDiv = document.getElementById('status');
    const detectedDiv = document.getElementById('detected');
    const mediaList = document.getElementById('media-list');
    const pendingDiv = document.getElementById('pending');
    const pendingList = document.getElementById('pending-list');

    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        const currentSite = document.getElementById('current-site');
        try {
            const hostname = new URL(tabs?.[0]?.url || '').hostname.replace(/^www\./, '');
            currentSite.textContent = hostname || 'This browser tab';
        } catch (_) {
            currentSite.textContent = 'This browser tab';
        }
    });

    function showStatus(message, type) {
        statusDiv.textContent = message;
        statusDiv.className = `status ${type}`;
        statusDiv.style.display = 'block';
        setTimeout(() => { statusDiv.style.display = 'none'; }, 3000);
    }

    function sendDownload(request, callback) {
        chrome.runtime.sendMessage({ action: 'download', ...request }, response => {
            if (chrome.runtime.lastError) callback?.(null);
            else callback?.(response);
        });
    }

    function refreshPending() {
        chrome.runtime.sendMessage({ action: 'getPending' }, response => {
            renderPending(response?.pending || []);
        });
    }

    function renderPending(items) {
        pendingList.replaceChildren();
        pendingDiv.style.display = items.length ? 'block' : 'none';
        for (const item of items) {
            const row = document.createElement('div');
            row.className = 'pending-item';
            const label = document.createElement('span');
            label.textContent = item.title || item.url || 'Download request';
            label.title = item.url || '';
            const retry = document.createElement('button');
            retry.textContent = 'Retry';
            retry.addEventListener('click', () => sendDownload(item, response => {
                if (response?.success) refreshPending();
                else showStatus('CyberDM is still unavailable', 'error');
            }));
            const remove = document.createElement('button');
            remove.className = 'pending-remove';
            remove.textContent = 'X';
            remove.title = 'Dismiss request';
            remove.addEventListener('click', () => {
                chrome.runtime.sendMessage({ action: 'removePending', timestamp: item.timestamp }, refreshPending);
            });
            row.append(label, retry, remove);
            pendingList.appendChild(row);
        }
    }

    downloadBtn.addEventListener('click', () => {
        const url = urlInput.value.trim();
        if (!url) return showStatus('Please enter a URL', 'error');
        sendDownload({ url, pageUrl: url, title: url, isYouTube: /youtube\.com|youtu\.be/i.test(url) }, response => {
            if (response?.success) {
                showStatus('Sent to CyberDM', 'success');
                urlInput.value = '';
            } else showStatus('CyberDM is unavailable; request queued for later', 'error');
            refreshPending();
        });
    });
    urlInput.addEventListener('keypress', event => { if (event.key === 'Enter') downloadBtn.click(); });
    document.getElementById('paste-btn').addEventListener('click', async () => {
        try {
            urlInput.value = await navigator.clipboard.readText();
            urlInput.focus();
            if (urlInput.value.trim()) showStatus('Link pasted. Ready to add.', 'success');
        } catch (_) {
            showStatus('Clipboard access is unavailable. Paste the link into the field.', 'error');
            urlInput.focus();
        }
    });

    document.getElementById('retry-all-pending').addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'getPending' }, response => {
            const items = response?.pending || [];
            if (!items.length) return renderPending([]);
            let completed = 0;
            let accepted = 0;
            items.forEach(item => sendDownload(item, result => {
                if (result?.success) accepted++;
                if (++completed === items.length) {
                    showStatus(`${accepted} of ${items.length} requests sent`, accepted ? 'success' : 'error');
                    refreshPending();
                }
            }));
        });
    });
    document.getElementById('clear-pending').addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'clearPending' }, () => renderPending([]));
    });

    scanBtn.addEventListener('click', () => {
        showStatus('Scanning page...', 'success');
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
            if (!tabs[0]) return showStatus('No active tab', 'error');
            chrome.tabs.sendMessage(tabs[0].id, { action: 'scan' }, response => {
                if (chrome.runtime.lastError) {
                    chrome.runtime.sendMessage({ action: 'scanPage' }, result => {
                        if (result?.success && result.videos) showDetectedMedia(result.videos);
                        else showStatus('No media found on this page', 'error');
                    });
                } else if (response?.videos?.length) showDetectedMedia(response.videos);
                else showStatus('No downloadable media found', 'error');
            });
        });
    });

    function showDetectedMedia(items) {
        if (!items?.length) return showStatus('No downloadable media found', 'error');
        detectedDiv.style.display = 'block';
        mediaList.replaceChildren();
        for (const item of items) {
            const row = document.createElement('div');
            row.className = 'media-item';
            const label = document.createElement('span');
            const quality = String(item.quality || item.format?.toUpperCase() || item.type || 'File');
            const size = String(item.sizeLabel || '');
            label.textContent = `${item.isYouTube ? '[Video] ' : ''}${quality}${size ? ' | ' + size : ''}`;
            const button = document.createElement('button');
            button.textContent = item.isYouTube ? 'App' : 'DL';
            button.addEventListener('click', () => sendDownload({
                url: String(item.url || ''),
                type: String(item.type || 'video'),
                pageUrl: String(item.pageUrl || ''),
                isYouTube: Boolean(item.isYouTube)
            }, response => {
                if (response?.success) {
                    button.textContent = 'OK';
                    button.disabled = true;
                } else {
                    button.textContent = 'Retry';
                    refreshPending();
                }
            }));
            row.append(label, button);
            mediaList.appendChild(row);
        }
        showStatus(`Found ${items.length} item(s)`, 'success');
    }

    const autoCaptureToggle = document.getElementById('auto-capture');
    chrome.storage.local.get(['autoCaptureEnabled'], result => {
        autoCaptureToggle.checked = result.autoCaptureEnabled !== false;
    });
    autoCaptureToggle.addEventListener('change', () => {
        chrome.storage.local.set({ autoCaptureEnabled: autoCaptureToggle.checked });
    });

    const includeCookiesToggle = document.getElementById('include-cookies');
    chrome.storage.local.get(['includeBrowserCookies'], result => {
        includeCookiesToggle.checked = result.includeBrowserCookies === true;
    });
    includeCookiesToggle.addEventListener('change', () => {
        chrome.storage.local.set({ includeBrowserCookies: includeCookiesToggle.checked });
    });

    refreshPending();
    setTimeout(() => scanBtn.click(), 500);
});
