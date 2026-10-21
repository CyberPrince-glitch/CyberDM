const fs = require('fs');
const path = require('path');
const { CHUNKS_PATH } = require('./constants');

/**
 * Scan CHUNKS_PATH for unfinished downloads and re‑queue them.
 * The function is called on app start after the downloadEngine is instantiated.
 *
 * @param {object} store - electron-store instance.
 * @param {SmartDownloadEngine} engine - instance that has a `processDownload` method.
 */
function recoverIncompleteDownloads(store, engine) {
    try {
        const downloads = store.get('downloads') || [];
        let changed = false;
        const incomplete = downloads.filter(d =>
            !d.isYtDlp && !['completed', 'cancelled', 'failed'].includes(d.status)
        );
        for (const dl of incomplete) {
            // Load saved chunk metadata if present
            const metaPath = path.join(CHUNKS_PATH, dl.id, 'metadata.json');
            if (fs.existsSync(metaPath)) {
                try {
                    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                    dl.chunks = meta.chunks;
                } catch (_) { /* ignore corrupted metadata */ }
            }
            // Ensure download directory exists for temp files
            const tempDir = path.join(CHUNKS_PATH, dl.id);
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            // Interrupted active jobs become queued again. The normal queue
            // enforces maxConcurrent; calling processDownload here directly
            // used to start every recovered item at once after restart.
            if (['downloading', 'retrying', 'connecting', 'merging'].includes(dl.status)) {
                dl.status = 'queued';
                dl.speed = 0;
                changed = true;
            }
        }
        if (changed) store.set('downloads', downloads);
        if (engine.getSettings().autoResume !== false) engine.startQueuedDownloads();
    } catch (e) {
        console.error('Error during recovery of incomplete downloads:', e);
    }
}

module.exports = { recoverIncompleteDownloads };
