'use strict';

function normalizeDownloadUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    const input = value.trim();
    try {
        const url = new URL(input);
        url.hash = '';
        return url.href;
    } catch (_) {
        return input;
    }
}

function findDuplicateDownload(downloads, sourceUrl, fileExists = () => false) {
    const normalizedSource = normalizeDownloadUrl(sourceUrl);
    if (!normalizedSource || !Array.isArray(downloads)) return null;
    for (const download of downloads) {
        const knownUrls = [download?.originalUrl, download?.url, download?.finalUrl]
            .map(normalizeDownloadUrl)
            .filter(Boolean);
        if (!knownUrls.includes(normalizedSource)) continue;
        if (['queued', 'downloading'].includes(download.status)) return { download, action: 'already-active' };
        if (['paused', 'failed'].includes(download.status)) return { download, action: 'resume' };
        if (download.status === 'completed' && download.savePath && fileExists(download.savePath)) {
            return { download, action: 'already-completed' };
        }
    }
    return null;
}

module.exports = { normalizeDownloadUrl, findDuplicateDownload };
