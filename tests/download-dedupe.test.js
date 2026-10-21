const fs = require('fs');
const os = require('os');
const path = require('path');
const { findDuplicateDownload, normalizeDownloadUrl } = require('../src/download-dedupe');

describe('download duplicate detection', () => {
    test('normalizes host casing and ignores fragments but retains query strings', () => {
        expect(normalizeDownloadUrl('HTTPS://EXAMPLE.COM/file.zip?token=abc#section'))
            .toBe('https://example.com/file.zip?token=abc');
        expect(normalizeDownloadUrl('https://example.com/file.zip?token=abc'))
            .not.toBe(normalizeDownloadUrl('https://example.com/file.zip?token=xyz'));
    });

    test('matches active items against original, redirected, and final URLs', () => {
        const item = { id: 'active-1', status: 'downloading', originalUrl: 'https://example.com/start', finalUrl: 'https://cdn.example.com/file.zip' };
        expect(findDuplicateDownload([item], 'https://cdn.example.com/file.zip')?.action).toBe('already-active');
    });

    test.each(['paused', 'failed'])('marks %s items for resume', status => {
        const item = { id: status, status, originalUrl: 'https://example.com/file.zip' };
        expect(findDuplicateDownload([item], item.originalUrl)?.action).toBe('resume');
    });

    test('skips a completed item only while its file exists', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cyberdm-dedupe-'));
        const filePath = path.join(directory, 'file.zip');
        try {
            fs.writeFileSync(filePath, 'complete');
            const item = { status: 'completed', originalUrl: 'https://example.com/file.zip', savePath: filePath };
            expect(findDuplicateDownload([item], item.originalUrl, fs.existsSync)?.action).toBe('already-completed');
            fs.unlinkSync(filePath);
            expect(findDuplicateDownload([item], item.originalUrl, fs.existsSync)).toBeNull();
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('does not match changed signed URLs or cancelled downloads', () => {
        const item = { status: 'cancelled', originalUrl: 'https://example.com/file.zip?token=old' };
        expect(findDuplicateDownload([item], 'https://example.com/file.zip?token=new')).toBeNull();
        expect(findDuplicateDownload([item], item.originalUrl)).toBeNull();
    });
});
