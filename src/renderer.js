// ========== CYBERDM RENDERER ==========

// State
let downloads = [];
let settings = {};
let currentCategory = 'all';
let selectedItems = new Set();

// Clipboard state
let clipboardUrl = null;
let clipboardCountdown = null;
let clipboardCountdownValue = 10;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    setupEventListeners();
    await Promise.all([loadSettings(), loadDownloads()]);
    startPolling();
    initSpeedGraph();
    initClipboardMonitor();
});

// ========== EVENT LISTENERS ==========
function setupEventListeners() {
    // Category navigation
    document.querySelectorAll('.category-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const category = item.dataset.category;
            selectCategory(category);
        });
    });

    // Select all checkbox
    document.getElementById('select-all').addEventListener('change', (e) => {
        const checked = e.target.checked;
        selectedItems.clear();
        if (checked) {
            downloads.forEach(d => selectedItems.add(d.id));
        }
        renderDownloads();
    });

    // Settings tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(`tab-${tab}`).classList.add('active');
        });
    });

    // Download events from main process
    cyberDM.onProgress((data) => updateDownloadProgress(data));
    cyberDM.onComplete((data) => onDownloadComplete(data));
    cyberDM.onError((data) => onDownloadError(data));
    cyberDM.onStatus((data) => onDownloadStatus(data));

    // URL Refresh request from extension
    cyberDM.onRefreshUrlRequest((data) => handleRefreshUrlRequest(data));
    cyberDM.onShowAddDialog((data) => {
        if (data?.url) {
            showVideoQualityDialog(data.url, data);
        } else {
            showAddDialog();
        }
    });
}

// ========== URL REFRESH HANDLER ==========
async function handleRefreshUrlRequest(data) {
    const { requestId, oldUrl, pageUrl, videoId } = data;

    try {
        // This would communicate with the Chrome extension via Native Messaging
        // For now, we'll try to refresh using stored page info
        console.log('URL refresh request:', requestId, oldUrl, pageUrl);

        // Show status message
        document.getElementById('status-message').textContent = 'Refreshing URL...';

        // The main process will handle the actual refresh
        // This is just UI feedback
    } catch (error) {
        console.error('URL refresh error:', error);
    }
}

// ========== CATEGORY FILTER ==========
function selectCategory(category) {
    currentCategory = category;
    document.querySelectorAll('.category-item').forEach(item => {
        item.classList.toggle('active', item.dataset.category === category);
    });
    renderDownloads();
}

function filterDownloads() {
    let filtered = downloads;

    // Filter by status category
    if (['downloading', 'queued', 'paused', 'completed', 'failed'].includes(currentCategory)) {
        filtered = filtered.filter(d => d.status === currentCategory);
    }

    // Filter by file type
    if (['video', 'audio', 'document', 'software', 'archive'].includes(currentCategory)) {
        filtered = filtered.filter(d => d.category === currentCategory);
    }

    return filtered;
}

// ========== DOWNLOADS ==========
async function loadDownloads() {
    try {
        downloads = await cyberDM.getDownloads();
        updateCounts();
        renderDownloads();
    } catch (error) {
        console.error('Failed to load downloads:', error);
    }
}

let _renderPending = false;
function renderDownloads() {
    // Debounce: batch multiple calls into one frame
    if (_renderPending) return;
    _renderPending = true;
    requestAnimationFrame(() => {
        _renderPending = false;
        _doRenderDownloads();
    });
}

function _doRenderDownloads() {
    const container = document.getElementById('download-list');
    const filtered = filterDownloads();

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">↓</div>
                <h3>No Downloads</h3>
                <p>Click "Add URL" or paste a link to start downloading</p>
                <button class="btn-add" onclick="showAddDialog()">Add Download</button>
            </div>
        `;
        return;
    }

    // Only rebuild if item count changed (structural change)
    const existingRows = container.querySelectorAll('.download-item');
    const rowsById = new Map(Array.from(existingRows, row => [row.dataset.id, row]));
    const existingIds = new Set(rowsById.keys());
    const filteredIds = new Set(filtered.map(d => d.id));

    const needsFullRebuild = existingIds.size !== filteredIds.size ||
        [...filteredIds].some(id => !existingIds.has(id)) ||
        [...existingIds].some(id => !filteredIds.has(id));

    if (needsFullRebuild) {
        container.innerHTML = filtered.map(download => createDownloadRow(download)).join('');
    } else {
        // Update existing rows in-place
        filtered.forEach(download => {
            const row = rowsById.get(download.id);
            if (!row) return;

            const downloaded = download.downloadedBytes || download.downloaded_bytes || 0;
            const total = download.totalBytes || download.total_bytes || 0;
            const progress = total > 0 ? (downloaded / total * 100).toFixed(1) : Number(download.progress || 0).toFixed(1);

            const sizeEl = row.querySelector('[data-field="size"]');
            const statusEl = row.querySelector('[data-field="status"]');
            const progressFill = row.querySelector('[data-field="progress-fill"]');
            const progressText = row.querySelector('[data-field="progress-text"]');
            const speedEl = row.querySelector('[data-field="speed"]');
            const etaEl = row.querySelector('[data-field="eta"]');

            if (sizeEl) sizeEl.textContent = formatSize(downloaded) + ' / ' + formatSize(total);
            if (statusEl) {
                const statusText = download.status.charAt(0).toUpperCase() + download.status.slice(1);
                statusEl.textContent = statusText;
                statusEl.className = 'item-status ' + download.status;
            }
            if (progressFill) {
                progressFill.style.width = progress + '%';
                if (download.status === 'completed') progressFill.classList.add('completed');
            }
            if (progressText) progressText.textContent = progress + '%';
            if (speedEl) speedEl.textContent = download.speed > 0 ? formatSpeed(download.speed) : '--';
            if (etaEl) etaEl.textContent = calculateETA(download);

            // Update row status class
            row.className = `download-item ${download.status}${selectedItems.has(download.id) ? ' selected' : ''}`;
        });
    }
}

function createDownloadRow(download) {
    const downloaded = download.downloadedBytes || download.downloaded_bytes || 0;
    const total = download.totalBytes || download.total_bytes || 0;
    const progress = total > 0
        ? (downloaded / total * 100).toFixed(1)
        : Number(download.progress || 0).toFixed(1);

    const sizeText = formatSize(downloaded) + ' / ' + formatSize(total);
    const speedText = download.speed > 0 ? formatSpeed(download.speed) : '--';
    const etaText = calculateETA(download);

    const statusClass = download.status;
    const statusText = download.status.charAt(0).toUpperCase() + download.status.slice(1);
    const progressClass = download.status === 'completed' ? 'completed' : '';

    const selected = selectedItems.has(download.id);

    // Action buttons for completed downloads
    const actionButtons = download.status === 'completed' ? `
        <div class="item-actions">
            <button class="action-btn open-btn" onclick="event.stopPropagation(); openFile('${download.id}')" title="Open File">▶</button>
            <button class="action-btn folder-btn" onclick="event.stopPropagation(); cyberDM.showInFolder('${download.id}')" title="Show in Folder">📁</button>
        </div>
    ` : '';

    return `
        <div class="download-item ${statusClass} ${selected ? 'selected' : ''}" data-id="${download.id}" title="${escapeHtml(download.errorMessage || download.error_message || '')}" onclick="toggleSelect('${download.id}', event)" ondblclick="openFile('${download.id}')">
            <div class="col col-select">
                <input type="checkbox" ${selected ? 'checked' : ''} onclick="event.stopPropagation(); toggleSelect('${download.id}')">
            </div>
            <div class="col col-name">
                <div class="item-name">
                    <span class="item-filename">${escapeHtml(download.filename)}</span>
                    <span class="item-url">${escapeHtml(download.url)}</span>
                </div>
                ${actionButtons}
            </div>
            <div class="col col-size">
                <span class="item-size" data-field="size">${sizeText}</span>
            </div>
            <div class="col col-status">
                <span class="item-status ${statusClass}" data-field="status">${statusText}</span>
            </div>
            <div class="col col-progress">
                <div class="item-progress">
                    <div class="progress-bar">
                        <div class="progress-fill ${progressClass}" data-field="progress-fill" style="width: ${progress}%"></div>
                    </div>
                    <span class="progress-text" data-field="progress-text">${progress}%</span>
                </div>
            </div>
            <div class="col col-speed">
                <span class="item-speed" data-field="speed">${speedText}</span>
            </div>
            <div class="col col-eta">
                <span class="item-eta" data-field="eta">${etaText}</span>
            </div>
        </div>
    `;
}

function updateCounts() {
    // Status counts
    document.getElementById('count-all').textContent = downloads.length;
    document.getElementById('count-downloading').textContent = downloads.filter(d => d.status === 'downloading').length;
    document.getElementById('count-queued').textContent = downloads.filter(d => d.status === 'queued').length;
    document.getElementById('count-paused').textContent = downloads.filter(d => d.status === 'paused').length;
    document.getElementById('count-completed').textContent = downloads.filter(d => d.status === 'completed').length;
    document.getElementById('count-failed').textContent = downloads.filter(d => d.status === 'failed').length;

    // Type counts
    document.getElementById('count-video').textContent = downloads.filter(d => d.category === 'video').length;
    document.getElementById('count-audio').textContent = downloads.filter(d => d.category === 'audio').length;
    document.getElementById('count-document').textContent = downloads.filter(d => d.category === 'document').length;
    document.getElementById('count-software').textContent = downloads.filter(d => d.category === 'software').length;
    document.getElementById('count-archive').textContent = downloads.filter(d => d.category === 'archive').length;

    // Status bar
    document.getElementById('status-downloading').textContent = downloads.filter(d => d.status === 'downloading').length;
    document.getElementById('status-queued').textContent = downloads.filter(d => d.status === 'queued').length;
    document.getElementById('status-completed').textContent = downloads.filter(d => d.status === 'completed').length;
}

// ========== SELECTION ==========
function toggleSelect(id, event) {
    if (event && event.target.type === 'checkbox') return;

    if (selectedItems.has(id)) {
        selectedItems.delete(id);
    } else {
        selectedItems.add(id);
    }
    renderDownloads();
}

function clearSelection() {
    selectedItems.clear();
    document.getElementById('select-all').checked = false;
    renderDownloads();
}

// ========== DIALOGS ==========
function showAddDialog() {
    document.getElementById('add-dialog').style.display = 'flex';
    document.getElementById('input-url').focus();
}

function hideAddDialog() {
    document.getElementById('add-dialog').style.display = 'none';
    document.getElementById('input-url').value = '';
    document.getElementById('input-path').value = '';
    document.getElementById('input-filename').value = '';
}

async function showScheduler() {
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let profile = null;
    try {
        const profiles = await cyberDM.getBandwidthProfiles();
        profile = profiles?.[0] || null;
    } catch (error) {
        console.error('Could not load bandwidth schedule:', error);
    }

    document.getElementById('scheduler-enabled').checked = Boolean(profile && profile.enabled !== false);
    document.getElementById('scheduler-start').value = profile?.start || '02:00';
    document.getElementById('scheduler-end').value = profile?.end || '08:00';
    document.getElementById('scheduler-speed').value = Number(profile?.limitKBps) || 0;
    const selectedDays = new Set(String(profile?.days || dayNames.join(',')).split(',').map(day => day.trim()));
    document.querySelectorAll('.days-checkboxes input[type="checkbox"]').forEach(input => {
        input.checked = selectedDays.has(dayNames[Number(input.value)]);
    });
    document.getElementById('scheduler-dialog').style.display = 'flex';
}

function hideScheduler() {
    document.getElementById('scheduler-dialog').style.display = 'none';
}

function showSettings() {
    loadSettingsToUI();
    document.getElementById('settings-dialog').style.display = 'flex';
}

function hideSettings() {
    document.getElementById('settings-dialog').style.display = 'none';
}

// ========== FILE CONFLICT DIALOG ==========
let pendingConflict = null;
let pendingDownloadData = null;

function showConflictDialog(conflictData, downloadData) {
    pendingConflict = conflictData;
    pendingDownloadData = downloadData;

    // Update dialog content
    document.getElementById('conflict-filename').textContent = conflictData.filename || 'Unknown file';

    if (conflictData.existingSize) {
        const sizeFormatted = formatSize(conflictData.existingSize);
        document.getElementById('conflict-size').textContent = sizeFormatted;
    } else {
        document.getElementById('conflict-size').textContent = 'Unknown size';
    }

    if (conflictData.existingDate) {
        const date = new Date(conflictData.existingDate);
        document.getElementById('conflict-date').textContent = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
    } else {
        document.getElementById('conflict-date').textContent = 'Unknown date';
    }

    // Show suggested rename
    if (conflictData.suggestedName) {
        const suggestedFilename = conflictData.suggestedName.split(/[/\\]/).pop();
        document.getElementById('conflict-newname').textContent = suggestedFilename;
        document.getElementById('conflict-preview').style.display = 'block';
    } else {
        document.getElementById('conflict-preview').style.display = 'none';
    }

    // Reset checkbox
    document.getElementById('conflict-remember').checked = false;

    // Show dialog
    document.getElementById('conflict-dialog').style.display = 'flex';
}

function hideConflictDialog() {
    document.getElementById('conflict-dialog').style.display = 'none';
    pendingConflict = null;
    pendingDownloadData = null;
}

async function handleConflictAction(action) {
    const rememberChoice = document.getElementById('conflict-remember').checked;

    // If remember choice is checked, update settings
    if (rememberChoice) {
        const newMode = action; // 'rename', 'overwrite', or 'skip'
        const newSettings = { ...settings, fileConflictMode: newMode };
        await cyberDM.saveSettings(newSettings);
        settings = newSettings;
        document.getElementById('status-message').textContent = 'Conflict mode saved: ' + newMode;
    }

    // Proceed with the chosen action
    if (action === 'skip') {
        hideConflictDialog();
        hideAddDialog();
        document.getElementById('status-message').textContent = 'Download skipped';
        return;
    }

    // For rename or overwrite, proceed with download
    if (pendingDownloadData) {
        try {
            let options = { ...pendingDownloadData.options };

            if (action === 'rename' && pendingConflict?.suggestedName) {
                // Use the suggested filename
                const suggestedFilename = pendingConflict.suggestedName.split(/[/\\]/).pop();
                options.filename = suggestedFilename;
            }
            // For overwrite, the backend will handle it based on the conflict check result

            const result = await cyberDM.startDownload(
                pendingDownloadData.url,
                pendingDownloadData.path,
                options
            );

            if (result.success) {
                hideConflictDialog();
                hideAddDialog();
                downloads.unshift(result.download);
                updateCounts();
                renderDownloads();
                document.getElementById('status-message').textContent = 'Download started: ' + result.download.filename;
            } else {
                alert('Failed to start download: ' + result.error);
            }
        } catch (error) {
            alert('Error: ' + error.message);
        }
    }

    hideConflictDialog();
}

function skipConflict() {
    handleConflictAction('skip');
}

function overwriteConflict() {
    handleConflictAction('overwrite');
}

function renameConflict() {
    handleConflictAction('rename');
}

// ========== DOWNLOAD ACTIONS ==========
let pendingVideoUrl = null;
let pendingVideoAuth = null;
let selectedFormatId = null;
let videoInfoCache = null;

async function addDownload() {
    const url = document.getElementById('input-url').value.trim();
    if (!url) {
        alert('Please enter a URL');
        return;
    }

    if (/^magnet:/i.test(url) || /\.torrent(?:[?#]|$)/i.test(url)) {
        try {
            const result = await cyberDM.addTorrent(url);
            if (!result.success) {
                alert('Failed to add torrent: ' + result.error);
                return;
            }
            hideAddDialog();
            await loadDownloads();
            document.getElementById('status-message').textContent = result.queued
                ? 'Torrent added to the queue'
                : 'Torrent download started';
        } catch (error) {
            alert('Error: ' + error.message);
        }
        return;
    }

    // Check if this is a video URL (YouTube, Facebook, etc.)
    try {
        const videoCheck = await cyberDM.isVideoUrl(url);
        if (videoCheck.isVideo) {
            hideAddDialog(); // Fix: Close the Add URL dialog first
            // Show video quality selection dialog
            await showVideoQualityDialog(url);
            return;
        }
    } catch (error) {
        // If video detection fails, continue with regular download
        console.log('Video detection failed, continuing with regular download:', error);
    }

    // Regular download
    await startRegularDownload(url);
}

async function captureLiveStream() {
    const url = document.getElementById('input-url').value.trim();
    if (!url) {
        alert('Enter a live stream URL first');
        return;
    }
    try {
        const destination = document.getElementById('input-path').value.trim() || null;
        const result = await cyberDM.grabStream({ url, quality: 'best', dest: destination });
        if (!result.success) {
            alert('Could not start stream capture: ' + result.error);
            return;
        }
        hideAddDialog();
        await loadDownloads();
        document.getElementById('status-message').textContent = result.queued
            ? 'Stream capture added to the queue'
            : 'Stream capture started';
    } catch (error) {
        alert('Could not start stream capture: ' + error.message);
    }
}

async function startRegularDownload(url) {
    const savePath = document.getElementById('input-path').value;
    const filename = document.getElementById('input-filename').value;
    const threads = parseInt(document.getElementById('input-threads').value);

    try {
        const result = await cyberDM.startDownload(url, savePath || null, { filename: filename || null, threads });

        if (result.success) {
            hideAddDialog();
            downloads.unshift(result.download);
            updateCounts();
            renderDownloads();
            document.getElementById('status-message').textContent = 'Download added: ' + result.download.filename;
        } else if (result.conflict) {
            // File conflict detected - show conflict dialog
            hideAddDialog();
            showConflictDialog(result.conflict, { url, savePath, options: { filename: filename || null, threads } });
        } else if (result.skipped) {
            // Download skipped by settings
            hideAddDialog();
            document.getElementById('status-message').textContent = 'Download skipped - file already exists';
        } else {
            alert('Failed to start download: ' + result.error);
        }
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

// ========== VIDEO QUALITY DIALOG ==========
async function showVideoQualityDialog(url, auth = null) {
    pendingVideoUrl = url;
    pendingVideoAuth = auth ? {
        encryptedAuthHeaders: auth.encryptedAuthHeaders || null,
        authHeaderOrigin: auth.authHeaderOrigin || null,
        pageUrl: auth.pageUrl,
        extensionRequestId: auth.extensionRequestId || null
    } : null;
    document.getElementById('video-quality-dialog').style.display = 'flex';
    document.getElementById('quality-options').innerHTML = '<div class="loading-quality">Loading available qualities...</div>';
    document.getElementById('video-title').textContent = 'Loading...';
    document.getElementById('video-thumbnail').style.display = 'none';
    document.getElementById('video-info-container').style.display = 'none';

    // Get video info
    try {
        const info = await cyberDM.getVideoInfo(url, pendingVideoAuth);
        if (!info.success) {
            throw new Error(info.error || 'Failed to get video info');
        }

        videoInfoCache = info;
        selectedFormatId = null;

        // Show video info
        document.getElementById('video-title').textContent = info.title || 'Unknown Title';
        if (info.thumbnail) {
            document.getElementById('video-thumbnail').innerHTML = `<img src="${info.thumbnail}" alt="Thumbnail" onerror="this.parentElement.style.display='none'">`;
            document.getElementById('video-thumbnail').style.display = 'block';
        }
        document.getElementById('video-info-container').style.display = 'flex';

        // Show quality options
        if (info.formats && info.formats.length > 0) {
            const qualityHtml = info.formats.map((fmt, index) => `
                <label class="quality-option ${index === 0 ? 'selected' : ''}" data-format-id="${fmt.formatId}" data-audio-only="${fmt.isAudio || false}">
                    <input type="radio" name="quality" value="${fmt.formatId}" ${index === 0 ? 'checked' : ''} onchange="selectQuality('${fmt.formatId}', ${fmt.isAudio || false})">
                    <div class="quality-info">
                        <span class="quality-label">${fmt.label}</span>
                        ${fmt.isBest ? '<span class="quality-badge">Best</span>' : ''}
                        ${fmt.isAudio ? '<span class="quality-badge audio">Audio Only</span>' : ''}
                    </div>
                </label>
            `).join('');
            document.getElementById('quality-options').innerHTML = qualityHtml;
            selectedFormatId = info.formats[0].formatId;
        } else {
            showBestAvailableVideoFallback('The site did not return a quality list.');
        }
    } catch (error) {
        showBestAvailableVideoFallback(`Could not load video details: ${error.message}`);
    }
}

function showBestAvailableVideoFallback(message) {
    const options = document.getElementById('quality-options');
    options.replaceChildren();
    const error = document.createElement('div');
    error.className = 'error-quality';
    error.textContent = message;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-secondary';
    button.textContent = 'Download best available format';
    button.addEventListener('click', startBestAvailableVideoDownload);
    options.append(error, button);
}

async function startBestAvailableVideoDownload() {
    const url = pendingVideoUrl;
    if (!url) return;
    const button = document.querySelector('#quality-options button');
    if (button?.disabled) return;
    if (button) button.disabled = true;
    const savePath = document.getElementById('video-save-path').value;
    document.getElementById('status-message').textContent = 'Starting video download…';

    try {
        const result = await cyberDM.downloadVideo(
            url, '', savePath || null, '', false, false, null, pendingVideoAuth,
            videoInfoCache?.title || null, null
        );
        if (!result.success) throw new Error(result.error || 'Video download could not be queued');
        hideVideoQualityDialog();
        hideAddDialog();
        document.getElementById('status-message').textContent = 'Video download queued using its page title';
        await loadDownloads();
    } catch (error) {
        document.getElementById('status-message').textContent = `Video download failed: ${error.message}`;
    } finally {
        if (button?.isConnected) button.disabled = false;
    }
}

function selectQuality(formatId, isAudio) {
    selectedFormatId = formatId;
    document.querySelectorAll('.quality-option').forEach(opt => {
        opt.classList.remove('selected');
        if (opt.dataset.formatId === formatId) {
            opt.classList.add('selected');
        }
    });
}

function hideVideoQualityDialog() {
    document.getElementById('video-quality-dialog').style.display = 'none';
    pendingVideoUrl = null;
    pendingVideoAuth = null;
    videoInfoCache = null;
    selectedFormatId = null;
}

async function browseVideoFolder() {
    const folder = await cyberDM.showFolderDialog();
    if (folder) {
        document.getElementById('video-save-path').value = folder;
    }
}

async function startVideoDownload() {
    if (!pendingVideoUrl || !selectedFormatId) {
        alert('Please select a quality option');
        return;
    }
    const downloadButton = document.querySelector('#video-quality-dialog .dialog-footer .btn-primary');
    if (downloadButton?.disabled) return;
    if (downloadButton) downloadButton.disabled = true;

    const savePath = document.getElementById('video-save-path').value;
    // Get selected format info
    const selectedOption = document.querySelector('.quality-option[data-format-id="' + selectedFormatId + '"]');
    const isAudio = selectedOption?.dataset.audioOnly === 'true';
    const selectedFormat = videoInfoCache?.formats?.find(format => String(format.formatId) === String(selectedFormatId));
    const hasAudio = selectedFormat?.acodec !== 'none' && selectedFormat?.acodec != null;
    const height = Number(selectedFormat?.height) || null;

    document.getElementById('status-message').textContent = 'Starting video download...';

    try {
        const result = await cyberDM.downloadVideo(
            pendingVideoUrl, selectedFormatId, savePath || null, '', isAudio, hasAudio,
            height, pendingVideoAuth, videoInfoCache?.title || null, selectedFormat?.ext || null
        );

        if (result.success) {
            hideVideoQualityDialog();
            hideAddDialog();
            document.getElementById('status-message').textContent = 'Video download started with the page title as its filename';

            // Refresh downloads
            await loadDownloads();
        } else {
            alert('Failed to start video download: ' + (result.error || 'Unknown error'));
        }
    } catch (error) {
        alert('Error: ' + error.message);
    } finally {
        if (downloadButton?.isConnected) downloadButton.disabled = false;
    }
}

async function pauseSelected() {
    for (const id of selectedItems) {
        await cyberDM.pauseDownload(id);
    }
    await loadDownloads();
}

async function resumeSelected() {
    for (const id of selectedItems) {
        await cyberDM.resumeDownload(id);
    }
    await loadDownloads();
}

async function cancelSelected() {
    for (const id of selectedItems) {
        await cyberDM.cancelDownload(id);
    }
    clearSelection();
    await loadDownloads();
}

async function deleteSelected() {
    if (selectedItems.size === 0) return;
    if (!confirm(`Delete ${selectedItems.size} download(s)?`)) return;

    for (const id of selectedItems) {
        await cyberDM.deleteDownload(id);
    }
    clearSelection();
    await loadDownloads();
}

// ========== FOLDER BROWSING ==========
async function browseFolder() {
    const folder = await cyberDM.showFolderDialog();
    if (folder) {
        document.getElementById('input-path').value = folder;
    }
}

async function browseSettingsFolder() {
    const folder = await cyberDM.showFolderDialog();
    if (folder) {
        document.getElementById('setting-path').value = folder;
    }
}

async function openFolder() {
    try {
        const result = await cyberDM.openDownloadFolder();
        if (!result.success) {
            document.getElementById('status-message').textContent = result.error || 'Failed to open folder';
        }
    } catch (error) {
        console.error('Failed to open folder:', error);
        document.getElementById('status-message').textContent = 'Failed to open folder';
    }
}

async function openExtensionFolder() {
    try {
        const result = await cyberDM.openExtensionFolder();
        if (result.success) {
            document.getElementById('status-message').textContent = 'Extension folder opened';
        } else {
            document.getElementById('status-message').textContent = result.error || 'Failed to open extension folder';
        }
    } catch (error) {
        console.error('Failed to open extension folder:', error);
        document.getElementById('status-message').textContent = 'Failed to open extension folder';
    }
}

// ========== QUEUE ==========
async function showQueueOrder() {
    document.getElementById('queue-order-dialog').style.display = 'flex';
    await renderQueueOrder();
}

function hideQueueOrder() {
    document.getElementById('queue-order-dialog').style.display = 'none';
}

async function renderQueueOrder() {
    const queue = await cyberDM.getQueue();
    const list = document.getElementById('queue-order-list');
    if (!queue.length) {
        list.innerHTML = '<p class="text-muted">There are no queued downloads.</p>';
        return;
    }
    list.innerHTML = queue.map((item, index) => `
        <div class="queue-order-item" style="display:flex;align-items:center;gap:10px;padding:8px;border-bottom:1px solid rgba(255,255,255,.1)">
            <span style="flex:1">${index + 1}. ${escapeHtml(item.filename || item.url || 'Download')}</span>
            <button class="btn-secondary" ${index === 0 ? 'disabled' : ''} onclick="moveQueueItem('${item.id}', -1)" aria-label="Move up">↑</button>
            <button class="btn-secondary" ${index === queue.length - 1 ? 'disabled' : ''} onclick="moveQueueItem('${item.id}', 1)" aria-label="Move down">↓</button>
        </div>`).join('');
}

async function moveQueueItem(id, direction) {
    const queue = await cyberDM.getQueue();
    const ids = queue.map(item => item.id);
    const index = ids.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    await cyberDM.reorderQueue(ids);
    await renderQueueOrder();
}

async function startQueue() {
    const result = await cyberDM.startQueue();
    document.getElementById('status-message').textContent = result.success ? 'Queue started' : 'Could not start queue';
    await loadDownloads();
}

async function stopQueue() {
    const result = await cyberDM.stopQueue();
    document.getElementById('status-message').textContent = result.success ? 'Queue stopped; active downloads will finish' : 'Could not stop queue';
    await loadDownloads();
}

// ========== SETTINGS ==========
async function loadSettings() {
    settings = await cyberDM.getSettings();
}

function loadSettingsToUI() {
    document.getElementById('setting-path').value = settings.downloadPath || '';
    document.getElementById('setting-threads').value = settings.chunkCount || 8;
    document.getElementById('setting-concurrent').value = settings.maxConcurrent || 3;
    document.getElementById('setting-speed').value = settings.speedLimit || 0;
    document.getElementById('setting-conflict-mode').value = settings.fileConflictMode || 'ask';
    document.getElementById('setting-tray').checked = settings.minimizeToTray !== false;
    document.getElementById('setting-startup').checked = settings.startWithWindows || false;
    document.getElementById('setting-notify').checked = settings.showNotification !== false;
    document.getElementById('setting-resume').checked = settings.autoResume !== false;
    document.getElementById('setting-timeout').value = settings.connectionTimeout || 30;
    document.getElementById('setting-retry').value = Number.isFinite(Number(settings.maxRetries)) ? settings.maxRetries : 5;
    document.getElementById('setting-delay').value = Math.max(1, Math.round((Number(settings.retryDelay) || 5000) / 1000));
    document.getElementById('setting-agent').value = settings.userAgent || 'CyberDM/1.0';
}

async function saveSettings() {
    const newSettings = {
        downloadPath: document.getElementById('setting-path').value,
        chunkCount: parseInt(document.getElementById('setting-threads').value),
        maxConcurrent: parseInt(document.getElementById('setting-concurrent').value),
        speedLimit: parseInt(document.getElementById('setting-speed').value),
        fileConflictMode: document.getElementById('setting-conflict-mode').value,
        minimizeToTray: document.getElementById('setting-tray').checked,
        startWithWindows: document.getElementById('setting-startup').checked,
        showNotification: document.getElementById('setting-notify').checked,
        autoResume: document.getElementById('setting-resume').checked,
        connectionTimeout: parseInt(document.getElementById('setting-timeout').value),
        maxRetries: parseInt(document.getElementById('setting-retry').value),
        retryDelay: parseInt(document.getElementById('setting-delay').value, 10) * 1000,
        userAgent: document.getElementById('setting-agent').value
    };

    await cyberDM.saveSettings(newSettings);
    settings = newSettings;
    hideSettings();
    document.getElementById('status-message').textContent = 'Settings saved';
}

async function saveScheduler() {
    const status = document.getElementById('status-message');
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const selectedDays = [...document.querySelectorAll('.days-checkboxes input[type="checkbox"]:checked')]
        .map(input => days[Number(input.value)])
        .filter(Boolean);
    const enabled = document.getElementById('scheduler-enabled').checked;
    const start = document.getElementById('scheduler-start').value;
    const end = document.getElementById('scheduler-end').value;
    const limitKBps = Number(document.getElementById('scheduler-speed').value);

    if (!Number.isFinite(limitKBps) || limitKBps < 0) {
        status.textContent = 'Enter a valid non-negative HTTP speed limit';
        return;
    }
    if (enabled && (!selectedDays.length || !start || !end || start === end)) {
        status.textContent = 'Choose at least one day and different start/end times';
        return;
    }

    try {
        const result = await cyberDM.saveBandwidthProfiles([{
            enabled,
            days: selectedDays.join(','),
            start,
            end,
            limitKBps,
            maxThreads: 0
        }]);
        if (!result?.success) throw new Error(result?.error || 'Could not save the schedule');
        hideScheduler();
        status.textContent = 'HTTP bandwidth schedule saved';
    } catch (error) {
        status.textContent = `Could not save schedule: ${error.message}`;
    }
}

// ========== PROGRESS UPDATES ==========
function updateDownloadProgress(data) {
    const download = downloads.find(d => d.id === data.id);
    if (download) {
        download.downloadedBytes = Number.isFinite(data.downloaded) ? data.downloaded : download.downloadedBytes || 0;
        download.progress = Number.isFinite(data.progress) ? data.progress : download.progress || 0;
        download.speed = Number.isFinite(data.speed) ? data.speed : download.speed || 0;
        download.avgSpeed = data.avgSpeed ?? download.avgSpeed;
        download.totalBytes = Number.isFinite(data.total) ? data.total : download.totalBytes || 0;
        download.status = 'downloading';

        // In-place DOM update (no flickering!)
        const row = document.querySelector(`.download-item[data-id="${data.id}"]`);
        if (row) {
            const downloaded = data.downloaded || 0;
            const total = data.total || 0;
            const progress = (total > 0 ? downloaded / total * 100 : download.progress || 0).toFixed(1);

            const sizeEl = row.querySelector('[data-field="size"]');
            const statusEl = row.querySelector('[data-field="status"]');
            const progressFill = row.querySelector('[data-field="progress-fill"]');
            const progressText = row.querySelector('[data-field="progress-text"]');
            const speedEl = row.querySelector('[data-field="speed"]');
            const etaEl = row.querySelector('[data-field="eta"]');

            if (sizeEl) sizeEl.textContent = formatSize(downloaded) + ' / ' + formatSize(total);
            if (statusEl) { statusEl.textContent = 'Downloading'; statusEl.className = 'item-status downloading'; }
            if (progressFill) progressFill.style.width = progress + '%';
            if (progressText) progressText.textContent = progress + '%';
            if (speedEl) speedEl.textContent = data.speed > 0 ? formatSpeed(data.speed) : '--';
            if (etaEl) etaEl.textContent = calculateETA(download);
        } else {
            // Row not found, do a full render
            renderDownloads();
        }

        updateCounts();
        updateSpeedGraph(data.speed);
    }
}

function onDownloadComplete(data) {
    const download = downloads.find(d => d.id === data.id);
    if (download) {
        if (data.filename) download.filename = data.filename;
        if (data.savePath) download.savePath = data.savePath;
        if (Number.isFinite(data.totalBytes)) download.totalBytes = data.totalBytes;
        if (Number.isFinite(data.downloadedBytes)) download.downloadedBytes = data.downloadedBytes;
        download.status = 'completed';
        download.downloadedBytes = download.totalBytes || download.downloadedBytes || 0;
        updateCounts();
        renderDownloads();

        // Play completion sound
        playCompletionSound();

        // Add row highlight animation
        highlightCompletedRow(data.id);

        // Show status message
        document.getElementById('status-message').textContent = 'Download completed: ' + download.filename;

        // Show smart notification
        if (settings.showNotification !== false) {
            showSmartNotification(download);
        }
    }
}

// ========== DOWNLOAD COMPLETE EFFECTS ==========
function playCompletionSound() {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();

        // Beautiful ascending chime: C5 → E5 → G5
        const notes = [
            { freq: 523.25, time: 0, duration: 0.3, volume: 0.25 },
            { freq: 659.25, time: 0.12, duration: 0.3, volume: 0.2 },
            { freq: 783.99, time: 0.24, duration: 0.5, volume: 0.2 },
            { freq: 1046.5, time: 0.36, duration: 0.6, volume: 0.15 }  // C6 - final high note
        ];

        notes.forEach(note => {
            const osc = audioContext.createOscillator();
            const gain = audioContext.createGain();
            osc.connect(gain);
            gain.connect(audioContext.destination);
            osc.frequency.value = note.freq;
            osc.type = 'sine';

            const t = audioContext.currentTime + note.time;
            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(note.volume, t + 0.04);
            gain.gain.exponentialRampToValueAtTime(0.001, t + note.duration);

            osc.start(t);
            osc.stop(t + note.duration);
        });
    } catch (e) {
        // Audio not available, skip silently
    }
}

// Open a downloaded file
async function openFile(id) {
    try {
        await cyberDM.openFile(id);
    } catch (error) {
        console.error('Failed to open file:', error);
    }
}


function highlightCompletedRow(downloadId) {
    // Find the row element and add glow effect
    setTimeout(() => {
        const row = document.querySelector(`[data-id="${downloadId}"]`);
        if (row) {
            row.classList.add('download-complete-flash');
            // Remove class after animation
            setTimeout(() => {
                row.classList.remove('download-complete-flash');
            }, 2000);
        }
    }, 50);
}

function showSmartNotification(download) {
    // Check notification permission
    if (Notification.permission === 'granted') {
        const notification = new Notification('Download Complete 🎉', {
            body: `${download.filename}\nSaved to Downloads`,
            icon: '../assets/icon.png',
            tag: download.id,
            requireInteraction: false
        });

        // Click to open folder
        notification.onclick = () => {
            cyberDM.showInFolder(download.id);
            notification.close();
        };
    } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(permission => {
            if (permission === 'granted') {
                showSmartNotification(download);
            }
        });
    }
}

function onDownloadError(data) {
    const download = downloads.find(d => d.id === data.id);
    if (download) {
        download.status = 'failed';
        download.error_message = data.error;
        updateCounts();
        renderDownloads();
        document.getElementById('status-message').textContent = 'Download failed: ' + data.error;
    }
}

function onDownloadStatus(data) {
    // Handle status updates like "Refreshing URL..."
    const download = downloads.find(d => d.id === data.id);
    if (download) {
        download.status = data.status;
        if (data.message) {
            document.getElementById('status-message').textContent = data.message;
        }
        renderDownloads();
    }
}

// ========== SPEED GRAPH ==========
let speedHistory = [];
const MAX_SPEED_POINTS = 50;

function initSpeedGraph() {
    speedHistory = new Array(MAX_SPEED_POINTS).fill(0);
}

function getSpeedClass(speed, maxSpeed) {
    if (speed === 0) return '';
    const ratio = speed / maxSpeed;
    if (ratio < 0.25) return 'low';
    if (ratio < 0.5) return 'medium';
    if (ratio < 0.75) return 'high';
    return 'peak';
}

function updateSpeedGraph(speed) {
    speedHistory.push(speed);
    speedHistory.shift();

    const maxSpeed = Math.max(...speedHistory, 1);
    const graph = document.getElementById('speed-graph');

    if (graph) {
        graph.innerHTML = speedHistory.map(s => {
            const height = Math.max((s / maxSpeed) * 100, 3);
            const speedClass = getSpeedClass(s, maxSpeed);
            return `<div class="speed-bar ${speedClass}" style="height: ${height}%"></div>`;
        }).join('');
    }

    // Update total speed display with smooth animation
    const totalSpeed = downloads
        .filter(d => d.status === 'downloading')
        .reduce((sum, d) => sum + (d.speed || 0), 0);

    const speedEl = document.getElementById('total-speed');
    speedEl.textContent = formatSpeed(totalSpeed);

    // Add pulse animation when speed is high
    if (totalSpeed > 5 * 1024 * 1024) { // > 5 MB/s
        speedEl.classList.add('speed-high');
    } else {
        speedEl.classList.remove('speed-high');
    }
}

// ========== POLLING ==========
function startPolling() {
    let pollInFlight = false;
    setInterval(async () => {
        if (document.visibilityState !== 'visible' || pollInFlight) return;
        pollInFlight = true;
        try { await loadDownloads(); }
        finally { pollInFlight = false; }
    }, 15000);
}

// ========== UTILITIES ==========
function formatSize(bytes) {
    if (!bytes || bytes <= 0 || !isFinite(bytes)) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSec) {
    return formatSize(bytesPerSec) + '/s';
}

function calculateETA(download) {
    // Guard against invalid values
    if (download.status !== 'downloading' || !download.speed || download.speed <= 0) return '--';
    const total = download.totalBytes || download.total_bytes || 0;
    const downloaded = download.downloadedBytes || download.downloaded_bytes || 0;
    if (!total || !downloaded) return '--';

    const remaining = total - downloaded;
    if (remaining <= 0) return '0s';

    const seconds = remaining / download.speed;
    // Guard against NaN/Infinity
    if (!isFinite(seconds) || seconds < 0) return '--';

    if (seconds < 60) return Math.floor(seconds) + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
    return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

function showNotification(title, body) {
    if (Notification.permission === 'granted') {
        new Notification(title, { body, icon: '../assets/icon.png' });
    } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(permission => {
            if (permission === 'granted') {
                new Notification(title, { body, icon: '../assets/icon.png' });
            }
        });
    }
}

// ========== CLIPBOARD AUTO-CAPTURE ==========
function initClipboardMonitor() {
    // Start clipboard monitoring
    cyberDM.startClipboardMonitor();

    // Listen for clipboard URL detected
    cyberDM.onClipboardUrl((data) => {
        showClipboardPopup(data);
    });
}

let clipboardCountdownInterval = null;

function showClipboardPopup(data) {
    clipboardUrl = data;

    // Update popup content
    document.getElementById('clipboard-filename').textContent = data.filename || 'Unknown file';
    document.getElementById('clipboard-type').textContent = data.type || 'File';
    document.getElementById('clipboard-url-display').textContent = data.url;

    // Get file info
    cyberDM.getUrlInfo(data.url).then(info => {
        if (info.success) {
            document.getElementById('clipboard-size').textContent = info.sizeFormatted || 'Unknown';
            document.getElementById('clipboard-filename').textContent = info.filename || data.filename || 'Unknown file';
        }
    });

    // Show popup
    const popup = document.getElementById('clipboard-popup');
    popup.style.display = 'block';

    // Start countdown
    clipboardCountdownValue = 10;
    document.getElementById('clipboard-countdown').textContent = clipboardCountdownValue;

    if (clipboardCountdownInterval) {
        clearInterval(clipboardCountdownInterval);
    }

    clipboardCountdownInterval = setInterval(() => {
        clipboardCountdownValue--;
        document.getElementById('clipboard-countdown').textContent = clipboardCountdownValue;

        if (clipboardCountdownValue <= 0) {
            hideClipboardPopup();
        }
    }, 1000);

    // Play notification sound (optional)
    // new Audio('notification.mp3').play().catch(() => {});
}

function hideClipboardPopup() {
    const popup = document.getElementById('clipboard-popup');
    popup.style.display = 'none';

    if (clipboardCountdownInterval) {
        clearInterval(clipboardCountdownInterval);
        clipboardCountdownInterval = null;
    }

    clipboardUrl = null;
    cyberDM.clearClipboardPending();
}

async function downloadClipboardUrl() {
    if (!clipboardUrl) return;

    // Stop countdown
    if (clipboardCountdownInterval) {
        clearInterval(clipboardCountdownInterval);
    }

    // Add download
    try {
        const result = await cyberDM.startDownload(clipboardUrl.url, null, {
            filename: clipboardUrl.filename
        });

        if (result.success) {
            hideClipboardPopup();
            downloads.unshift(result.download);
            updateCounts();
            renderDownloads();
            document.getElementById('status-message').textContent = 'Download started: ' + result.download.filename;
        } else if (result.conflict) {
            // File conflict detected - show conflict dialog
            hideClipboardPopup();
            showConflictDialog(result.conflict, { url: clipboardUrl.url, savePath: null, options: { filename: clipboardUrl.filename } });
        } else if (result.skipped) {
            hideClipboardPopup();
            document.getElementById('status-message').textContent = 'Download skipped - file already exists';
        } else {
            alert('Failed to start download: ' + result.error);
        }
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

// ========== KEYBOARD SHORTCUTS ==========
document.addEventListener('keydown', (e) => {
    // Escape to close dialogs
    if (e.key === 'Escape') {
        hideAddDialog();
        hideScheduler();
        hideSettings();
        hideUpdateDialog();
    }

    // Ctrl+A to add download
    if (e.ctrlKey && e.key === 'a' && !e.target.matches('input, textarea')) {
        e.preventDefault();
        showAddDialog();
    }

    // Delete key to delete selected
    if (e.key === 'Delete' && selectedItems.size > 0) {
        deleteSelected();
    }
});


// Update dialog
function hideUpdateDialog() {
    const dialog = document.getElementById('update-dialog');
    if (dialog) dialog.style.display = 'none';
}

async function downloadUpdate() {
    try {
        const update = await cyberDM.checkUpdates();
        if (update.downloadUrl) {
            window.open(update.downloadUrl, '_blank');
        }
    } catch (err) {}
}

// Check updates and show dialog if needed
async function checkForUpdatesUI() {
    try {
        const update = await cyberDM.checkUpdates();
        if (update.needsUpdate) {
            const currentEl = document.getElementById('update-current');
            const latestEl = document.getElementById('update-latest');
            const msgEl = document.getElementById('update-message');
            const dialog = document.getElementById('update-dialog');
            
            if (currentEl) currentEl.textContent = update.currentVersion || '0.2.0';
            if (latestEl) latestEl.textContent = update.latestVersion || '0.3.0';
            if (dialog) dialog.style.display = 'flex';
        }
    } catch (err) {}
}

// ========== MAYA AI CHAT ==========
let mayaTTSEnabled = false;

function toggleMayaChat() {
    const panel = document.getElementById('maya-chat-panel');
    if (!panel) return;
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'flex';
    if (!isOpen) initMaya();
}

async function initMaya() {
    try {
        const keyInfo = await cyberDM.getGeminiKey();
        const hint = document.getElementById('maya-api-hint');
        if (hint) hint.style.display = keyInfo.hasKey ? 'none' : 'flex';
        
        if (keyInfo.hasKey) {
            const greeting = await cyberDM.getMayaGreeting();
            const greetingEl = document.getElementById('maya-greeting');
            if (greetingEl) greetingEl.textContent = greeting.greeting;
        }
    } catch (e) {}
}

async function saveMayaKey() {
    const input = document.getElementById('maya-api-key-input');
    if (!input || !input.value.trim()) return;
    await cyberDM.setGeminiKey(input.value.trim());
    input.value = '';
    const hint = document.getElementById('maya-api-hint');
    if (hint) hint.style.display = 'none';
    appendMayaMsg('bot', 'API key saved! 💜 Now we can chat! Ask me anything~');
}

function appendMayaMsg(role, text) {
    const container = document.getElementById('maya-messages');
    if (!container) return;
    const div = document.createElement('div');
    div.className = `maya-msg maya-msg-${role}`;
    if (role === 'bot') {
        div.innerHTML = `<span class="maya-msg-avatar">💜</span><div class="maya-msg-bubble">${text}</div>`;
    } else {
        div.innerHTML = `<span class="maya-msg-avatar">👤</span><div class="maya-msg-bubble">${text}</div>`;
    }
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div;
}

function showMayaTyping() {
    const container = document.getElementById('maya-messages');
    const div = document.createElement('div');
    div.className = 'maya-msg maya-msg-bot';
    div.id = 'maya-typing-indicator';
    div.innerHTML = `<span class="maya-msg-avatar">💜</span><div class="maya-typing"><span></span><span></span><span></span></div>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function hideMayaTyping() {
    const t = document.getElementById('maya-typing-indicator');
    if (t) t.remove();
}

async function sendToMaya() {
    const input = document.getElementById('maya-input');
    if (!input) return;
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';

    appendMayaMsg('user', msg);
    showMayaTyping();

    try {
        const result = await cyberDM.chatWithMaya(msg);
        hideMayaTyping();
        if (result.success) {
            appendMayaMsg('bot', result.reply);
            if (mayaTTSEnabled) speakMaya(result.reply);
        } else {
            appendMayaMsg('bot', result.error || 'Something went wrong... 😔');
            if (!result.error?.includes('API key')) return;
            const hint = document.getElementById('maya-api-hint');
            if (hint) hint.style.display = 'flex';
        }
    } catch (err) {
        hideMayaTyping();
        appendMayaMsg('bot', 'Oops, something went wrong 😔 ' + err.message);
    }
}

function clearMayaChat() {
    const container = document.getElementById('maya-messages');
    if (container) container.innerHTML = '';
    cyberDM.clearMayaHistory();
    appendMayaMsg('bot', 'Chat cleared! 💜 Fresh start~');
}

function toggleMayaTTS() {
    mayaTTSEnabled = !mayaTTSEnabled;
    const btn = document.getElementById('maya-tts-btn');
    if (btn) btn.textContent = mayaTTSEnabled ? '🔊' : '🔇';
    if (mayaTTSEnabled) speakMaya('Voice mode on! Now you can hear me~');
}

function speakMaya(text) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const cleanText = text.replace(/[💜✨💕🎉🌟💭😔❤🎬👤⚡]/g, '').trim();
    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.rate = 1.0;
    utterance.pitch = 1.15;
    utterance.volume = 0.9;
    // Try to pick a female voice
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(v => v.name.includes('Female') || v.name.includes('Zira') || v.name.includes('Samantha'));
    if (preferred) utterance.voice = preferred;
    window.speechSynthesis.speak(utterance);
}

async function searchMoviesUI() {
    const query = prompt('🎬 What type of movies are you looking for?');
    if (!query) return;
    
    appendMayaMsg('user', '🎬 Search: ' + query);
    showMayaTyping();

    try {
        const result = await cyberDM.searchMovies(query);
        hideMayaTyping();
        if (result.success && result.movies?.length > 0) {
            appendMayaMsg('bot', `Found ${result.movies.length} recommendations for you! 💜`);
            const moviesDiv = document.getElementById('maya-movie-results');
            if (moviesDiv) {
                moviesDiv.style.display = 'block';
                moviesDiv.innerHTML = result.movies.map(m => `
                    <div class="maya-movie-card" onclick="navigator.clipboard.writeText('${m.searchTerm || m.title}')">
                        <div class="maya-movie-title">${m.title}</div>
                        <div class="maya-movie-year">${m.year || ''}</div>
                        <div class="maya-movie-desc">${m.desc || ''}</div>
                    </div>
                `).join('');
            }
        } else {
            appendMayaMsg('bot', result.error || 'Couldn\'t find movies right now 😔');
        }
    } catch (err) {
        hideMayaTyping();
        appendMayaMsg('bot', 'Search failed: ' + err.message);
    }
}

// Maya download notification
async function mayaNotifyDownload(filename) {
    try {
        const result = await cyberDM.getMayaDownloadPhrase();
        if (result.phrase) {
            appendMayaMsg('bot', result.phrase + '\n📁 ' + filename);
            if (mayaTTSEnabled) speakMaya(result.phrase);
        }
    } catch (e) {}
}

// ========== TUTORIAL / SUPPORT / DEV LINKS ==========
function showTutorial() {
    document.getElementById('tutorial-dialog').style.display = 'flex';
}

function sendSupportEmail() {
    const subject = encodeURIComponent('CyberDM Support — v1.0.1');
    const body = encodeURIComponent('Hi CyberDM Team,\n\nI need help with:\n\n\n---\nDevice info: ' + navigator.userAgent);
    window.location.href = 'mailto:xcyberprince@gmail.com?subject=' + subject + '&body=' + body;
}

function openDevYouTube() {
    cyberDM.openExternal('https://www.youtube.com/@CyberPrinceTrick');
}

function openDevFacebook() {
    cyberDM.openExternal('https://www.facebook.com/CyberPrinceOfficialID');
}

async function saveGeminiKeyFromSettings() {
    const input = document.getElementById('setting-gemini-key');
    if (!input || !input.value.trim()) { alert('Please enter your Gemini API key'); return; }
    await cyberDM.setGeminiKey(input.value.trim());
    input.value = '';
    alert('✅ Gemini API Key saved! Maya AI is now active. Click 💜 to chat.');
}

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(checkForUpdatesUI, 5000);
    // Pre-load voices for TTS
    if ('speechSynthesis' in window) window.speechSynthesis.getVoices();
});
