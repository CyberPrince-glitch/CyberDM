// src/auto-extractor.js

/**
 * Auto‑Extract module for CyberDM.
 *
 * After a download finishes (and if the user has enabled the setting),
 * the engine calls `autoExtract(filePath)` which detects the archive
 * type and unpacks it to `<filePath>_extracted`.
 *
 * Supported formats: .zip, .tar, .tar.gz, .tgz, .tar.bz2, .tar.xz
 * RAR / 7z require external binaries (unrar / 7z).
 */

const fs   = require('fs');
const path = require('path');
const StreamZip = require('node-stream-zip');
const tar = require('tar');

/**
 * Main extraction function.
 *
 * @param {string}  filePath  – full path to the downloaded file
 * @param {object}  [opts]    – optional overrides
 * @param {string}  [opts.dest]      – custom extraction directory
 * @param {boolean} [opts.deleteOrig] – delete original archive after extraction
 * @returns {Promise<string>}  path to the extracted folder
 */
async function autoExtract(filePath, opts = {}) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    const dest = opts.dest || `${filePath}_extracted`;
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }

    const ext = path.extname(filePath).toLowerCase();
    const base = path.basename(filePath).toLowerCase();

    // --- .zip -------------------------------------------------------
    if (ext === '.zip') {
        const zip = new StreamZip.async({ file: filePath });
        const count = await zip.extract(null, dest);
        await zip.close();

        if (opts.deleteOrig) fs.unlinkSync(filePath);
        return dest;
    }

    // --- .tar / .tar.gz / .tgz / .tar.bz2 / .tar.xz ----------------
    if (ext === '.tar' || base.endsWith('.tar.gz')  ||
        base.endsWith('.tgz')   || base.endsWith('.tar.bz2') ||
        base.endsWith('.tar.xz')) {
        await tar.x({ file: filePath, cwd: dest });

        if (opts.deleteOrig) fs.unlinkSync(filePath);
        return dest;
    }

    // --- .gz (single‑file gzip) ------------------------------------
    if (ext === '.gz' && !base.endsWith('.tar.gz')) {
        const zlib = require('zlib');
        const outName = path.basename(filePath, '.gz');
        const outPath = path.join(dest, outName);

        await new Promise((resolve, reject) => {
            const inp = fs.createReadStream(filePath);
            const out = fs.createWriteStream(outPath);
            inp.pipe(zlib.createGunzip())
                .pipe(out)
                .on('finish', resolve)
                .on('error', reject);
        });

        if (opts.deleteOrig) fs.unlinkSync(filePath);
        return dest;
    }

    // --- .rar -------------------------------------------------------
    if (ext === '.rar') {
        // Requires `unrar` or `winrar` in PATH.
        // Example using child_process:
        const { spawnSync } = require('child_process');
        const result = spawnSync('unrar', ['x', '-y', filePath, dest + path.sep], {
            stdio: 'inherit'
        });
        if (result.error || result.status !== 0) {
            throw new Error('unrar failed – is it installed?');
        }
        if (opts.deleteOrig) fs.unlinkSync(filePath);
        return dest;
    }

    // --- .7z --------------------------------------------------------
    if (ext === '.7z') {
        const { spawnSync } = require('child_process');
        const result = spawnSync('7z', ['x', filePath, `-o${dest}`, '-y'], {
            stdio: 'inherit'
        });
        if (result.error || result.status !== 0) {
            throw new Error('7z extraction failed – is 7-Zip installed?');
        }
        if (opts.deleteOrig) fs.unlinkSync(filePath);
        return dest;
    }

    throw new Error(`Unsupported archive type: ${ext}`);
}

/**
 * Determine whether a file is a supported archive.
 * @param {string} filePath
 * @returns {boolean}
 */
function isArchive(filePath) {
    const supported = ['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz'];
    const p = filePath.toLowerCase();
    for (const ext of supported) {
        if (p.endsWith(ext)) return true;
    }
    // .tar.gz etc.
    if (p.includes('.tar.')) return true;
    return false;
}

module.exports = { autoExtract, isArchive };