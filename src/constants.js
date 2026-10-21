const path = require('path');
const { app } = require('electron');

const APP_DATA = app.getPath('userData');
const DOWNLOADS_PATH = app.getPath('downloads');
const TEMP_PATH = path.join(APP_DATA, 'temp');
const CHUNKS_PATH = path.join(APP_DATA, 'chunks');

const SMART_CHUNK_CONFIG = {
    MIN_CHUNK_SIZE: 512 * 1024, // 512 KB
    DEFAULT_THREADS: 4,
    MAX_THREADS: 8,
    MONITOR_INTERVAL: 2000, // ms
    SPEED_THRESHOLD: 50 * 1024, // 50 KB/s -> split
    MAX_SPLIT_DEPTH: 2
};

module.exports = {
    APP_DATA,
    DOWNLOADS_PATH,
    TEMP_PATH,
    CHUNKS_PATH,
    SMART_CHUNK_CONFIG
};
