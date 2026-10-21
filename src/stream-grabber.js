// src/stream-grabber.js

/**
 * Stream Grabber for live streams (YouTube, Twitch, etc.)
 * Uses yt-dlp to fetch HLS / DASH URLs and records them via ffmpeg.
 *
 * Dependencies: yt-dlp (binary) packaged in tools/, fluent-ffmpeg.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Grab a live stream for a given URL and save to the specified folder.
 *
 * @param {string} streamUrl   – e.g. YouTube watch URL
 * @param {string} outDir      – folder to store the recorded file
 * @param {object} [opts]      – optional overrides
 * @param {string} [opts.format] – yt-dlp format selector (default: best)
 * @param {function} [opts.onProgress] – callback(progressInfo)
 * @returns {Promise<string>} full path to the recorded file
 */
function grabStream(streamUrl, outDir, opts = {}) {
    return new Promise((resolve, reject) => {
        // Resolve yt-dlp binary path – bundled tools folder first
        const ytDlpPath = findYtDlp();
if (!ytDlpPath) {
            return reject(new Error('yt-dlp binary not found'));
        }
        const format = opts.format || 'best[ext=mp4]/best';
        const args = [
            '--no-warnings',
            '--quiet',
            '--no-call-home',
            '--no-progress',
            '--restrict-filenames',
            '-f', format,
            '-g', // print the direct media URL(s) only
            streamUrl
        ];

        // First, obtain the direct media URL(s) via yt-dlp
        const ytdlp = spawn(ytDlpPath, args);
        let urlOutput = '';
        let errOutput = '';
        ytdlp.stdout.on('data', d => urlOutput += d.toString());
        ytdlp.stderr.on('data', d => errOutput += d.toString());
        ytdlp.on('close', code => {
            if (code !== 0) {
                return reject(new Error(`yt-dlp exited ${code}: ${errOutput}`));
            }
            const mediaUrls = urlOutput.trim().split('\n').filter(Boolean);
            if (!mediaUrls.length) return reject(new Error('No media URL found from yt-dlp'));
            // Typically the first URL is the best format (e.g., HLS master)
            const mediaUrl = mediaUrls[0];
            // Start ffmpeg recording to file
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const outFile = path.join(outDir, `stream-${timestamp}.mp4`);
            const ffmpegPath = findFfmpeg();
            const ffArgs = [
                '-y', // overwrite
                '-i', mediaUrl,
                '-c', 'copy',
                outFile
            ];

            const ff = spawn(ffmpegPath || 'ffmpeg', ffArgs);
            ff.stderr.on('data', d => {
                // ffmpeg prints progress to stderr
                const str = d.toString();
                const timeMatch = str.match(/time=([0-9:.]+)/);
                if (timeMatch && typeof opts.onProgress === 'function') {
                    opts.onProgress({ elapsed: timeMatch[1] });
                }
            });
            ff.on('close', code => {
                if (code === 0) {
                    resolve(outFile);
                } else {
                    reject(new Error(`ffmpeg exited ${code}`));
                }
            });
        });
    });
}

/** Fetch the available yt-dlp formats for the stream quality picker. */
function listStreamQualities(streamUrl) {
    return new Promise((resolve) => {
        const ytDlpPath = findYtDlp();
        if (!ytDlpPath) {
            resolve({ success: false, error: 'Video engine not found' });
            return;
        }

        let stdout = '';
        let stderr = '';
        let settled = false;
        const child = spawn(ytDlpPath, ['--dump-single-json', '--no-warnings', '--no-playlist', streamUrl]);
        const timeout = setTimeout(() => {
            child.kill();
            finish({ success: false, error: 'Stream quality lookup timed out' });
        }, 30000);
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(result);
        };

        child.stdout.on('data', chunk => {
            stdout += chunk.toString();
            if (stdout.length > 32 * 1024 * 1024) {
                child.kill();
                finish({ success: false, error: 'Stream format information is too large' });
            }
        });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', error => finish({ success: false, error: error.message }));
        child.on('close', code => {
            if (settled) return;
            if (code !== 0) {
                finish({ success: false, error: stderr.trim() || `Video engine exited with code ${code}` });
                return;
            }
            try {
                const info = JSON.parse(stdout);
                const formats = (info.formats || []).map(format => ({
                    formatId: String(format.format_id),
                    label: format.format_note || format.resolution || format.ext || 'Available format',
                    ext: format.ext || null,
                    height: Number.isFinite(Number(format.height)) ? Number(format.height) : null,
                    filesize: Number(format.filesize || format.filesize_approx) || null,
                    hasAudio: format.acodec && format.acodec !== 'none',
                    hasVideo: format.vcodec && format.vcodec !== 'none'
                }));
                finish({ success: true, title: info.title || '', formats });
            } catch (error) {
                finish({ success: false, error: `Could not parse stream formats: ${error.message}` });
            }
        });
    });
}

/**
 * Locate yt-dlp binary – prefers bundled version in tools/.
 * @returns {string|null}
 */
function findYtDlp() {
    const possible = [
        path.join(__dirname, '..', 'tools', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'),
        path.join(process.resourcesPath || '', 'tools', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
    ];
    for (const p of possible) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

/**
 * Find ffmpeg binary – re‑use the helper from video-converter.
 */
function findFfmpeg() {
    // Duplicate logic – could import from video-converter but avoid circular deps
    const possible = [
        path.join(__dirname, '..', 'tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
        path.join(process.resourcesPath || '', 'tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    ];
    for (const p of possible) {
        if (fs.existsSync(p)) return p;
    }
    return null; // fallback to system PATH
}

module.exports = { grabStream, listStreamQualities };
