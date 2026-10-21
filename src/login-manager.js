// src/login-manager.js

/**
 * Login Manager for handling credential flows.
 * Supports storing encrypted credentials in electron‑store and
 * provides a simple API for the UI to request login dialogs.
 */

const crypto = require('crypto');
let store = null;

function init(storeInstance) {
    store = storeInstance;
}

/**
 * Save credentials for a host (or service).
 * The password is encrypted with a key derived from the app secret.
 *
 * @param {string} host
 * @param {object} cred { username, password }
 */
function saveCredentials(host, cred) {
    if (!store) return;
    const secret = getAppSecret();
    const encrypted = encrypt(JSON.stringify(cred), secret);
    store.set(`login.${host}`, encrypted);
}

/**
 * Retrieve credentials for a host.
 * @param {string} host
 * @returns {object|null}
 */
function getCredentials(host) {
    if (!store) return null;
    const encrypted = store.get(`login.${host}`);
    if (!encrypted) return null;
    try {
        const secret = getAppSecret();
        const decrypted = decrypt(encrypted, secret);
        return JSON.parse(decrypted);
    } catch (_) { return null; }
}

/**
 * Simple encryption using AES‑256‑GCM.
 */
function encrypt(text, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(key).digest(), iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(blob, key) {
    const [ivHex, tagHex, encHex] = blob.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const encrypted = Buffer.from(encHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(key).digest(), iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
}

/**
 * Derive a per‑installation secret – fallback to a constant for simplicity.
 */
function getAppSecret() {
    // In production, use a random key stored in a secure location.
    return process.env.APP_SECRET || 'cyberdm-default-secret';
}

module.exports = { init, saveCredentials, getCredentials };