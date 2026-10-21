// src/bandwidth-scheduler.js

/**
 * Bandwidth Scheduler for CyberDM.
 *
 * Reads time-based profiles from electron-store and applies scheduled HTTP
 * speed caps to the SmartDownloadEngine at 1-minute intervals. The legacy
 * maxThreads profile field is retained in storage but is not applied yet.
 *
 * Profile format (JSON array):
 * [
 *   {
 *     "days":     "Mon,Tue,Wed,Thu,Fri",
 *     "start":    "08:00",
 *     "end":      "18:00",
 *     "limitKBps": 512,
 *     "maxThreads": 2
 *   },
 *   { ... }
 * ]
 */

let store = null;
let downloadEngine = null;
let intervalId = null;
let currentProfile = null;

/**
 * Initialise the scheduler.
 *
 * @param {import('electron-store')} storeInstance
 * @param {object} engine – SmartDownloadEngine instance
 */
function init(storeInstance, engine) {
    store = storeInstance;
    downloadEngine = engine;
}

/**
 * Start the 1‑minute tick loop.
 */
function start() {
    tick(); // immediate evaluation
    if (intervalId) clearInterval(intervalId);
    intervalId = setInterval(tick, 60_000);
}

/**
 * Stop the scheduler.
 */
function stop() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
}

/**
 * Return the current raw profiles array from store.
 * @returns {Array}
 */
function getProfiles() {
    if (!store) return [];
    return store.get('bandwidthProfiles') || [];
}

/**
 * Persist profiles (called from settings UI).
 * @param {Array} profiles
 */
function setProfiles(profiles) {
    if (!store) return;
    store.set('bandwidthProfiles', profiles);
    tick(); // re‑evaluate immediately
}

/**
 * Main timer tick – match current day/time against profiles.
 */
function tick() {
    if (!downloadEngine) return;

    const profiles = getProfiles();
    const now = new Date();

    const dayAbbr = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dayName = dayAbbr[now.getDay()];
    const previousDayName = dayAbbr[(now.getDay() + 6) % 7];
    const minutes = now.getHours() * 60 + now.getMinutes();

    // Find first matching profile
    let match = null;
    for (const p of profiles) {
        if (p.enabled === false) continue;
        const days = (p.days || '').split(',').map(d => d.trim());
        const [sh, sm] = (p.start || '00:00').split(':').map(Number);
        const [eh, em] = (p.end   || '23:59').split(':').map(Number);
        const startMin = sh * 60 + sm;
        const endMin   = eh * 60 + em;
        if (![startMin, endMin].every(Number.isFinite)) continue;

        const active = startMin <= endMin
            ? days.includes(dayName) && minutes >= startMin && minutes <= endMin
            : (days.includes(dayName) && minutes >= startMin) ||
              (days.includes(previousDayName) && minutes <= endMin);
        if (active) {
            match = p;
            break;
        }
    }

    const profile = match || { limitKBps: 0, maxThreads: 0, enabled: false };

    // Avoid unnecessary updates
    if (currentProfile &&
        currentProfile.limitKBps === profile.limitKBps &&
        currentProfile.maxThreads === profile.maxThreads &&
        currentProfile.active === !!match) {
        return;
    }

    currentProfile = { ...profile, active: !!match };

    // Apply the scheduled cap separately so it never overwrites the user's saved limit.
    if (typeof downloadEngine.setScheduledSpeedLimit === 'function') {
        downloadEngine.setScheduledSpeedLimit(profile.limitKBps || 0);
    }

    // Notify renderer
    try {
        const { BrowserWindow } = require('electron');
        const wins = BrowserWindow.getAllWindows();
        for (const win of wins) {
            if (!win.isDestroyed()) {
                win.webContents.send('bandwidth:scheduler-changed', {
                    active: !!match,
                    profile: profile
                });
            }
        }
    } catch (_) { /* ignore */ }
}

module.exports = { init, start, stop, getProfiles, setProfiles, tick };
