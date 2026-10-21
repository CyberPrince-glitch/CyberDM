// src/checksum.js
//
// Checksum Verification Module
// Supports MD5, SHA-1, SHA-256, SHA-512.
// Used to verify downloaded files against expected hashes.

const crypto = require('crypto');
const fs = require('fs');

/**
 * Supported hash algorithms.
 */
const SUPPORTED_ALGORITHMS = ['md5', 'sha1', 'sha256', 'sha512'];

/**
 * Normalize algorithm name (e.g., "SHA-256" -> "sha256").
 * @param {string} algo
 * @returns {string}
 */
function normalizeAlgorithm(algo) {
    const cleaned = algo.replace(/[-_]/g, '').toLowerCase();
    const map = {
        md5: 'md5',
        sha1: 'sha1',
        sha256: 'sha256',
        sha512: 'sha512',
    };
    if (!map[cleaned]) {
        throw new Error(
            `Unsupported algorithm: "${algo}". Supported: ${SUPPORTED_ALGORITHMS.join(', ')}`
        );
    }
    return map[cleaned];
}

/**
 * Verify a file's checksum against an expected hash.
 *
 * @param {object} opts
 * @param {string} opts.filePath    - absolute path to file
 * @param {string} opts.expected    - expected hash (hex string)
 * @param {string} opts.algorithm   - md5 / sha1 / sha256 / sha512
 * @returns {Promise<{ valid: boolean, computed: string, expected: string, algorithm: string, message: string }>}
 */
async function verifyChecksum(opts) {
    const { filePath, expected, algorithm } = opts;
    if (!filePath || !expected || !algorithm) {
        throw new Error('Missing required option: filePath, expected, or algorithm');
    }
    const algo = normalizeAlgorithm(algorithm);
    const normalizedExpected = expected.trim().toLowerCase();

    return new Promise((resolve, reject) => {
        const hash = crypto.createHash(algo);
        const stream = fs.createReadStream(filePath);

        stream.on('error', (err) => {
            reject(new Error(`Failed to read file "${filePath}": ${err.message}`));
        });

        stream.on('data', (chunk) => { hash.update(chunk); });

        stream.on('end', () => {
            const computed = hash.digest('hex');
            const valid = computed === normalizedExpected;
            resolve({
                valid,
                computed,
                expected: normalizedExpected,
                algorithm: algo,
                message: valid
                    ? `Checksum OK (${algo})`
                    : `Checksum MISMATCH (${algo}): expected ${normalizedExpected}, got ${computed}`,
            });
        });
    });
}

/**
 * Compute a checksum for a file on disk.
 *
 * @param {object} opts
 * @param {string} opts.filePath
 * @param {string} opts.algorithm  - md5 / sha1 / sha256 / sha512
 * @returns {Promise<{ hex: string, algorithm: string, fileSize: number }>}
 */
async function computeChecksum(opts) {
    const { filePath, algorithm } = opts;
    const algo = normalizeAlgorithm(algorithm);

    return new Promise((resolve, reject) => {
        const hash = crypto.createHash(algo);
        let fileSize = 0;
        const stream = fs.createReadStream(filePath);

        stream.on('error', (err) => {
            reject(new Error(`Failed to read file "${filePath}": ${err.message}`));
        });

        stream.on('data', (chunk) => {
            fileSize += chunk.length;
            hash.update(chunk);
        });

        stream.on('end', () => {
            resolve({
                hex: hash.digest('hex'),
                algorithm: algo,
                fileSize,
            });
        });
    });
}

/**
 * Parse a checksum line: "abc123  file.zip" or "abc123".
 * @param {string} line
 * @returns {{ hash: string, filename: string|null }}
 */
function parseChecksumLine(line) {
    const parts = line.trim().split(/\s+/);
    return parts.length >= 2
        ? { hash: parts[0].toLowerCase(), filename: parts[1] }
        : { hash: parts[0].toLowerCase(), filename: null };
}

/**
 * Infer algorithm from hash hex length.
 * @param {string} hash
 * @returns {string}
 */
function inferAlgorithm(hash) {
    const len = hash.length;
    if (len === 32) return 'md5';
    if (len === 40) return 'sha1';
    if (len === 64) return 'sha256';
    if (len === 128) return 'sha512';
    throw new Error(`Cannot infer algorithm from hash length ${len}`);
}

module.exports = {
    SUPPORTED_ALGORITHMS,
    normalizeAlgorithm,
    verifyChecksum,
    computeChecksum,
    parseChecksumLine,
    inferAlgorithm,
};