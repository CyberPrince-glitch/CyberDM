// src/proxy-manager.js

/**
 * Proxy Manager for CyberDM.
 *
 * Stores proxy configuration in electron‑store and can inject
 * a proxy agent into Node.js HTTP/HTTPS request options, as well
 * as return a proxy URL string for yt‑dlp or other CLI tools.
 */

let store = null;

/**
 * Bind electron‑store instance.
 * @param {import('electron-store')} storeInstance
 */
function init(storeInstance) {
    store = storeInstance;
}

/**
 * Default proxy configuration.
 */
const DEFAULT_PROXY = {
    enabled: false,
    type:     'http',    // http | https | socks5
    host:     '',
    port:     8080,
    username: '',
    password: ''
};

/**
 * Return current proxy config.
 * @returns {object}
 */
function getConfig() {
    if (!store) return DEFAULT_PROXY;
    return { ...DEFAULT_PROXY, ...(store.get('proxy') || {}) };
}

/**
 * Persist proxy config.
 * @param {object} cfg – partial or full proxy options
 */
function setConfig(cfg) {
    if (!store) return;
    store.set('proxy', { ...getConfig(), ...cfg });
}

/**
 * Build a proxy URL string suitable for Axios `proxy`, yt‑dlp `--proxy`,
 * or `https-proxy-agent`. Returns null when the proxy is disabled.
 *
 * @returns {string|null} e.g. "http://user:pass@host:1080"
 */
function buildProxyUrl() {
    const cfg = getConfig();
    if (!cfg.enabled || !cfg.host) return null;

    const auth = cfg.username && cfg.password
        ? `${encodeURIComponent(cfg.username)}:${encodeURIComponent(cfg.password)}@`
        : cfg.username
            ? `${encodeURIComponent(cfg.username)}@`
            : '';

    return `${cfg.type}://${auth}${cfg.host}:${cfg.port}`;
}

/**
 * Get an HTTP/HTTPS agent suitable for passing to `http.request()` or
 * `https.request()` options. Returns `undefined` if proxy is disabled.
 *
 * The returned agent is imported lazily so that end users do not need
 * to install the proxy packages unless they actually enable a proxy.
 *
 * @returns {object|undefined}
 */
function buildHttpAgent() {
    const url = buildProxyUrl();
    if (!url) return undefined;

    const { HttpProxyAgent } = require('http-proxy-agent');
    const { HttpsProxyAgent } = require('https-proxy-agent');

    return {
        http:  new HttpProxyAgent(url),
        https: new HttpsProxyAgent(url)
    };
}

/**
 * Apply proxy to a plain http/https request options block.
 * @param {object} options - will be mutated
 * @returns {object} the same options object
 */
function applyProxy(options = {}) {
    const agent = buildProxyAgent();
    if (agent) {
        options.agent = options.agent || agent;
    }
    return options;
}

module.exports = {
    init,
    getConfig,
    setConfig,
    buildProxyUrl,
    buildHttpAgent,
    applyProxy
};