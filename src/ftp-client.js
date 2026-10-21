// src/ftp-client.js

/**
 * FTP / FTPS client using `basic-ftp`.
 *
 * Usage:
 *   const { downloadFtp, getFileSize } = require('./ftp-client');
 *   await downloadFtp(urlObj, destPath, signal, onProgress);
 *
 * Install dependency:  npm install basic-ftp
 */

const fs  = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

/**
 * Download a remote FTP / FTPS file into a local path.
 *
 * @param {URL}      urlObj     – parsed URL (protocol ftp: or ftps:)
 * @param {string}   destPath   – full local output path
 * @param {AbortSignal} signal  – abort controller signal
 * @param {function} onProgress – ({ downloaded, total, percent })
 * @returns {Promise<number>} bytes written
 */
async function downloadFtp(urlObj, destPath, signal, onProgress) {
    // Lazy‑import basic‑ftp so the app can start without the dependency
    const ftp = require('basic-ftp');

    const client = new ftp.Client();
    client.ftp.verbose = false;

    // Abort handling
    let aborted = false;
    const onAbort = () => { aborted = true; client.close(); };
    if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
    }

    const host = urlObj.hostname;
    const port = urlObj.port || (urlObj.protocol === 'ftps:' ? 990 : 21);
    const user = decodeURIComponent(urlObj.username || 'anonymous');
    const pass = decodeURIComponent(urlObj.password || 'anonymous@');
    const secure = urlObj.protocol === 'ftps:';
    const remoteFile = decodeURIComponent(urlObj.pathname);

    try {
        await client.access({ host, port, user, password: pass, secure });

        // Get total size
        const fileSize = await client.size(remoteFile);

        // Ensure dest dir exists
        const dir = path.dirname(destPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        let written = 0;

        // Track progress with basic-ftp's built‑in tracker
        client.trackProgress(info => {
            if (aborted) return;
            written = info.bytes;
            if (onProgress) {
                onProgress({
                    downloaded: written,
                    total: info.bytesOverall || fileSize,
                    readable: {
                        ...info
                    }
                });
            }
        });

        if (aborted) throw new Error('AbortError');

        await client.downloadTo(destPath, remoteFile);

        client.close();
        return written;
    } catch (err) {
        client.close();
        if (aborted) {
            const abortErr = new Error('Download aborted');
            abortErr.name = 'AbortError';
            throw abortErr;
        }
        throw err;
    } finally {
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

/**
 * Quickly determine the add size of a remote FTP / FTPS file
 * without downloading it.
 *
 * @param {URL}    urlObj
 * @returns {Promise<number>}
 */
async function getFtpFileSize(urlObj) {
    const ftp = require('basic-ftp');
    const client = new ftp.Client();
    client.ftp.verbose = false;

    const host = urlObj.hostname;
    const port = urlObj.port || (urlObj.protocol === 'ftps:' ? 990 : 21);
    const user = decodeURIComponent(urlObj.username || 'anonymous');
    const pass = decodeURIComponent(urlObj.password || 'anonymous@');
    const secure = urlObj.protocol === 'ftps:';

    try {
        await client.access({ host, port, user, password: pass, secure });
        const size = await client.size(decodeURIComponent(urlObj.pathname));
        client.close();
        return size;
    } catch (e) {
        client.close();
        throw e;
    }
}

module.exports = { downloadFtp, getFtpFileSize };