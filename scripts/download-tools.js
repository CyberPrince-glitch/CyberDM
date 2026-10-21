const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Keep this pinned to an upstream yt-dlp release. The installed version is
// checked at every build so an old local executable cannot silently ship.
const YTDLP_VERSION = process.env.CYBERDM_YTDLP_VERSION || '2026.08.19';
const YTDLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp.exe`;
const toolsDir = path.join(__dirname, '..', 'tools');
const destination = path.join(toolsDir, 'yt-dlp.exe');
const temporary = `${destination}.download`;

fs.mkdirSync(toolsDir, { recursive: true });

function installedVersion(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const result = spawnSync(filePath, ['--version'], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true
    });
    if (result.error || result.status !== 0) return null;
    return (result.stdout || '').trim();
}

function downloadFile(url, destinationPath, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 8) return reject(new Error('Too many redirects'));

        const request = https.get(url, { headers: { 'User-Agent': 'CyberDM-build' } }, response => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                const nextUrl = new URL(response.headers.location, url).toString();
                downloadFile(nextUrl, destinationPath, redirectCount + 1).then(resolve, reject);
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`Download failed with HTTP ${response.statusCode}`));
                return;
            }

            const file = fs.createWriteStream(destinationPath);
            response.on('error', reject);
            file.on('error', reject);
            file.on('finish', () => file.close(resolve));
            response.pipe(file);
        });
        request.setTimeout(30000, () => request.destroy(new Error('Download timed out')));
        request.on('error', reject);
    });
}

async function main() {
    const current = installedVersion(destination);
    if (current === YTDLP_VERSION) {
        console.log(`yt-dlp ${current} is already installed.`);
        return;
    }

    console.log(`Updating bundled yt-dlp from ${current || 'missing'} to ${YTDLP_VERSION}...`);
    try { fs.rmSync(temporary, { force: true }); } catch (_) {}
    try {
        await downloadFile(YTDLP_URL, temporary);
        const downloadedVersion = installedVersion(temporary);
        if (downloadedVersion !== YTDLP_VERSION) {
            throw new Error(`Downloaded yt-dlp version ${downloadedVersion || 'could not be read'}, expected ${YTDLP_VERSION}`);
        }
        fs.rmSync(destination, { force: true });
        fs.renameSync(temporary, destination);
        console.log(`Bundled yt-dlp ${YTDLP_VERSION} is ready.`);
    } catch (error) {
        try { fs.rmSync(temporary, { force: true }); } catch (_) {}
        throw new Error(`Could not install the required yt-dlp ${YTDLP_VERSION}: ${error.message}`);
    }
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
