const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { SMART_CHUNK_CONFIG, CHUNKS_PATH } = require('./constants');

/**
 * Generate an array of chunk descriptors for a download.
 * Mirrors the former createSmartChunks logic but is exported as splitChunk.
 *
 * @param {Object} download - The download object (must contain id).
 * @param {number} totalSize - Size in bytes of the file.
 * @param {number} threadCount - Desired number of initial threads.
 * @returns {Array} Array of chunk objects.
 */
function splitChunk(download, totalSize, threadCount) {
    const sanitizedSize = isNaN(totalSize) ? 0 : Math.max(0, parseInt(totalSize, 10) || 0);
    // If server doesn't support resume or size unknown, fallback to single chunk
    if (!download.supportsResume || sanitizedSize <= 0) {
        return [{
            id: uuidv4(),
            downloadId: download.id,
            index: 0,
            startByte: 0,
            endByte: sanitizedSize > 0 ? sanitizedSize - 1 : -1,
            downloadedBytes: 0,
            status: 'pending',
            tempPath: path.join(CHUNKS_PATH, download.id, 'chunk_0.tmp')
        }];
    }

    const chunks = [];
    const optimalChunkSize = Math.max(
        Math.floor(sanitizedSize / threadCount),
        SMART_CHUNK_CONFIG.MIN_CHUNK_SIZE
    );

    let currentByte = 0;
    let index = 0;
    while (currentByte < sanitizedSize) {
        const endByte = Math.min(currentByte + optimalChunkSize - 1, sanitizedSize - 1);
        chunks.push({
            id: uuidv4(),
            downloadId: download.id,
            index,
            startByte: currentByte,
            endByte,
            downloadedBytes: 0,
            status: 'pending',
            tempPath: path.join(CHUNKS_PATH, download.id, `chunk_${index}.tmp`),
            speed: 0,
            lastActiveTime: Date.now(),
            splitCount: 0 // track depth for future splitting
        });
        currentByte = endByte + 1;
        index++;
    }
    return chunks;
}

module.exports = { splitChunk };
