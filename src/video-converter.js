// src/video-converter.js

/**
 * Video / audio converter for CyberDM using fluent-ffmpeg.
 *
 * Usage:
 *   const { convertVideo } = require('./video-converter');
 *   const outPath = await convertVideo(source, destDir, { format: 'mp3' });
 *
 * Install dependencies:  npm install fluent-ffmpeg
 *                         ffmpeg must be installed on the system or
 *                         placed in tools/ffmpeg.exe (Windows).
 */

const path = require('path');

/**
 * Convert a media file.
 *
 * @param {string}   sourcePath  – input video / audio file
 * @param {string|object} options – output directory OR { destDir, format, preset, ... }
 * @param {function} [onProgress] – ({ percent, fps, currentKbps, timemark })
 * @returns {Promise<string>} full output file path
 */
function convertVideo(sourcePath, options, onProgress) {
    return new Promise((resolve, reject) => {
        // Normalise args
        let outDir, opts = {};

        if (typeof options === 'string') {
            outDir = options;
        } else if (options && typeof options === 'object') {
            outDir = options.dest || options.dir || path.dirname(sourcePath);
            opts = { ...options };
        } else {
            outDir = path.dirname(sourcePath);
        }

        const fmt = opts.format || 'mp4';
        const baseName = path.parse(sourcePath).name;
        const outPath = path.join(outDir, `${baseName}.${fmt}`);

        // Resolve ffmpeg binary – try bundled tool first
        const ffmpegPath = findFfmpeg();
        const ffmpeg = require('fluent-ffmpeg');
        if (ffmpegPath) {
            ffmpeg.setFfmpegPath(ffmpegPath);
        }

        let command = ffmpeg(sourcePath)
            .output(outPath)
            .on('end', () => resolve(outPath))
            .on('error', (err) => reject(err));

        // Attach progress callback
        if (onProgress) {
            command = command.on('progress', onProgress);
        }

        // Apply presets
        switch (fmt) {
            case 'mp3':
                command = command
                    .noVideo()
                    .audioCodec('libmp3lame')
                    .audioBitrate(opts.bitrate || '192k');
                break;

            case 'webm':
                command = command
                    .videoCodec('libvpx-vp9')
                    .audioCodec('libopus');
                if (opts.bitrate) command = command.videoBitrate(opts.bitrate);
                break;

            case 'mp4':
            default:
                command = command
                    .videoCodec('libx264')
                    .audioCodec('aac');
                if (opts.preset) command = command.outputOptions('-preset', opts.preset);
                else command = command.outputOptions('-preset', 'fast');
                if (opts.bitrate) command = command.videoBitrate(opts.bitrate);
                break;
        }

        command.run();
    });
}

/**
 * Try to locate ffmpeg in the bundled tools folder or PATH.
 * Returns the absolute path.
 */
function findFfmpeg() {
    const fs = require('fs');

    // 1. Bundled tools folder (electron‑builder extraResources)
    const possible = [
        path.join(__dirname, '..', 'tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
        path.join(process.resourcesPath || '', 'tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    ];

    for (const p of possible) {
        if (fs.existsSync(p)) return p;
    }

    // 2. Rely on PATH (fluent‑ffmpeg will search automatically if not set)
    return null;
}

module.exports = { convertVideo, findFfmpeg };