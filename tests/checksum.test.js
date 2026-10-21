const fs = require('fs');
const path = require('path');
const { verifyChecksum, computeChecksum, parseChecksumLine, inferAlgorithm, normalizeAlgorithm } = require('../src/checksum');

describe('Checksum Module', () => {
    const testFile = path.join(__dirname, '__test_file.tmp');

    beforeAll(() => {
        fs.writeFileSync(testFile, 'Hello World', 'utf8');
    });

    afterAll(() => {
        if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
    });

    describe('computeChecksum', () => {
        test('should compute MD5 of a file', async () => {
            const result = await computeChecksum({ filePath: testFile, algorithm: 'md5' });
            expect(result.hex).toBe('b10a8db164e0754105b7a99be72e3fe5');
            expect(result.algorithm).toBe('md5');
            expect(result.fileSize).toBe(11);
        });

        test('should compute SHA-1 of a file', async () => {
            const result = await computeChecksum({ filePath: testFile, algorithm: 'sha1' });
            expect(result.hex).toBe('0a4d55a8d778e5022fab701977c5d840bbc486d0');
        });

        test('should compute SHA-256 of a file', async () => {
            const result = await computeChecksum({ filePath: testFile, algorithm: 'sha256' });
            expect(result.hex).toBe('a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e');
        });
    });

    describe('verifyChecksum', () => {
        test('should return valid=true for correct MD5', async () => {
            const result = await verifyChecksum({
                filePath: testFile,
                algorithm: 'md5',
                expected: 'b10a8db164e0754105b7a99be72e3fe5'
            });
            expect(result.valid).toBe(true);
            expect(result.message).toContain('OK');
        });

        test('should return valid=false for wrong hash', async () => {
            const result = await verifyChecksum({
                filePath: testFile,
                algorithm: 'md5',
                expected: 'deadbeefdeadbeefdeadbeefdeadbeef'
            });
            expect(result.valid).toBe(false);
            expect(result.message).toContain('MISMATCH');
        });

        test('should throw on missing options', async () => {
            await expect(verifyChecksum({ algorithm: 'md5' }))
                .rejects.toThrow('Missing required option');
        });
    });

    describe('inferAlgorithm', () => {
        test('should infer MD5 from 32-char hash', () => {
            expect(inferAlgorithm('b10a8db164e0754105b7a99be72e3fe5')).toBe('md5');
        });

        test('should infer SHA-1 from 40-char hash', () => {
            expect(inferAlgorithm('0a4d55a8d778e5022fab701977c5d840bbc486d0')).toBe('sha1');
        });

        test('should infer SHA-256 from 64-char hash', () => {
            expect(inferAlgorithm('a591a6d40bf420404a011733cfb7b190d62a65bf0bcda33b57b57dd5cd9f146e')).toBe('sha256');
        });

        test('should throw on unknown length', () => {
            expect(() => inferAlgorithm('abc')).toThrow('Cannot infer algorithm');
        });
    });

    describe('normalizeAlgorithm', () => {
        test('should handle hyphenated names', () => {
            expect(normalizeAlgorithm('SHA-256')).toBe('sha256');
        });
        test('should throw on unsupported', () => {
            expect(() => normalizeAlgorithm('blake2')).toThrow('Unsupported algorithm');
        });
    });

    describe('parseChecksumLine', () => {
        test('should parse space-separated checksum line', () => {
            const result = parseChecksumLine('abc123  file.zip');
            expect(result.hash).toBe('abc123');
            expect(result.filename).toBe('file.zip');
        });

        test('should parse hash-only line', () => {
            const result = parseChecksumLine('abc123');
            expect(result.hash).toBe('abc123');
            expect(result.filename).toBeNull();
        });
    });
});