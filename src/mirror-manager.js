// src/mirror-manager.js

/**
 * Mirror / Fallback URL Manager for CyberDM.
 *
 * Stores domain‑specific mirror lists in electron‑store and provides
 * round‑robin rotation for chunk‑level failover.
 *
 * Mirrors are persisted under key `mirrors[domain]` = [url1, url2, …]
 */

let store = null;

/**
 * Bind the electron-store instance after app init.
 * @param {import('electron-store')} storeInstance
 */
function init(storeInstance) {
    store = storeInstance;
}

/**
 * Return all mirror lists keyed by domain.
 * @returns {Record<string, string[]>}
 */
function getAllMirrors() {
    if (!store) return {};
    return store.get('mirrors') || {};
}

/**
 * Add a mirror URL for a domain.
 * @param {string} domain - e.g. 'example.com'
 * @param {string} url
 */
function addMirror(domain, url) {
    if (!store) return;
    const mirrors = getAllMirrors();
    if (!mirrors[domain]) mirrors[domain] = [];
    if (!mirrors[domain].includes(url)) {
        mirrors[domain].push(url);
    }
    store.set('mirrors', mirrors);
}

/**
 * Remove a mirror URL for a domain.
 * @param {string} domain
 * @param {string} url
 */
function removeMirror(domain, url) {
    if (!store) return;
    const mirrors = getAllMirrors();
    if (mirrors[domain]) {
        mirrors[domain] = mirrors[domain].filter(u => u !== url);
        if (mirrors[domain].length === 0) delete mirrors[domain];
        store.set('mirrors', mirrors);
    }
}

/**
 * Retrieve mirrors for a given absolute URL.
 * @param {string} originalUrl
 * @returns {string[]}
 */
function getMirrorsForUrl(originalUrl) {
    try {
        const host = new URL(originalUrl).hostname;
        const mirrors = getAllMirrors();
        return (mirrors[host] || []).filter(u => u !== originalUrl);
    } catch (_) {
        return [];
    }
}

/**
 * Simple round‑robin iterator per download.
 * Returns the next available mirror URL, or null.
 *
 * @param {object}  download  - download object (needs `.id` and `.originalUrl`)
 * @param {string}  failedUrl - the URL that just failed so we skip it
 * @returns {string|null}
 */
function rotateMirror(download, failedUrl) {
    const mirrors = getMirrorsForUrl(download.originalUrl || download.url);
    if (!mirrors.length) return null;

    const idxKey = `_mirrorIdx_${download.id}`;
    let idx = store ? (store.get(idxKey) || 0) : 0;

    // try each mirror, skipping the one that just failed
    for (let i = 0; i < mirrors.length; i++) {
        const candidate = mirrors[(idx + i) % mirrors.length];
        if (candidate !== failedUrl) {
            if (store) store.set(idxKey, (idx + i + 1) % mirrors.length);
            return candidate;
        }
    }

    return null; // all exhausted
}

/**
 * Clear all mirrors for a domain.
 * @param {string} domain
 */
function clearMirrorsForDomain(domain) {
    if (!store) return;
    const mirrors = getAllMirrors();
    delete mirrors[domain];
    store.set('mirrors', mirrors);
}

module.exports = {
    init,
    getAllMirrors,
    addMirror,
    removeMirror,
    getMirrorsForUrl,
    rotateMirror,
    clearMirrorsForDomain
};