const path = require('path');
const { splitChunk } = require('../src/chunk-splitter');

describe('Chunk Splitter Module', () => {
    const mockDownload = {
        id: 'test-dl-001',
        supportsResume: true,
        url: 'https://example.com/test.zip',
    };

    describe('splitChunk', () => {
        test('should create single chunk when supportsResume is false', () => {
            const dl = { ...mockDownload, supportsResume: false };
            const chunks = splitChunk(dl, 1024 * 1024, 4);
            expect(chunks).toHaveLength(1);
            expect(chunks[0].index).toBe(0);
            expect(chunks[0].startByte).toBe(0);
            expect(chunks[0].status).toBe('pending');
        });

        test('should create single chunk when totalSize is 0', () => {
            const chunks = splitChunk(mockDownload, 0, 4);
            expect(chunks).toHaveLength(1);
            expect(chunks[0].startByte).toBe(0);
        });

        test('should create single chunk when totalSize is negative', () => {
            const chunks = splitChunk(mockDownload, -500, 4);
            expect(chunks).toHaveLength(1);
            expect(chunks[0].startByte).toBe(0);
        });

        test('should split evenly by threadCount for large file', () => {
            // Use file large enough that MIN_CHUNK_SIZE doesn't limit
            const totalSize = 8 * 1024 * 1024; // 8 MB
            const chunks = splitChunk(mockDownload, totalSize, 4);
            expect(chunks).toHaveLength(4);
            const expectedSize = Math.floor(totalSize / 4);
            for (let i = 0; i < 4; i++) {
                expect(chunks[i].startByte).toBe(i * expectedSize);
                expect(chunks[i].index).toBe(i);
            }
            expect(chunks[3].endByte).toBe(totalSize - 1);
        });

        test('should limit chunks by MIN_CHUNK_SIZE', () => {
            // 1 MB file with 4 threads → MIN_CHUNK_SIZE of 512KB forces 2 chunks
            const totalSize = 1024 * 1024;
            const chunks = splitChunk(mockDownload, totalSize, 4);
            expect(chunks).toHaveLength(2);
            expect(chunks[0].startByte).toBe(0);
            expect(chunks[1].startByte).toBe(524288);
            expect(chunks[1].endByte).toBe(totalSize - 1);
        });

        test('should respect MIN_CHUNK_SIZE when totalSize is small', () => {
            // 1 KB file with 8 threads should still get reasonable chunk size
            const chunks = splitChunk(mockDownload, 1024, 8);
            // With MIN_CHUNK_SIZE of 512KB, a 1KB file should produce few chunks
            expect(chunks.length).toBeGreaterThan(0);
            chunks.forEach(c => {
                expect(c.endByte - c.startByte + 1).toBeGreaterThan(0);
            });
        });

        test('should assign unique IDs to each chunk', () => {
            const chunks = splitChunk(mockDownload, 1024 * 1024, 4);
            const ids = chunks.map(c => c.id);
            expect(new Set(ids).size).toBe(ids.length); // all unique
        });

        test('should set correct tempPath for each chunk', () => {
            const chunks = splitChunk(mockDownload, 1024 * 1024, 2);
            chunks.forEach((c, i) => {
                expect(c.tempPath).toContain(mockDownload.id);
                expect(c.tempPath).toContain(`chunk_${i}.tmp`);
            });
        });

        test('should initialize properties for parallel chunk', () => {
            const chunks = splitChunk(mockDownload, 1024 * 1024, 2);
            chunks.forEach(c => {
                expect(c.downloadId).toBe(mockDownload.id);
                expect(c.downloadedBytes).toBe(0);
                expect(c.status).toBe('pending');
                expect(c).toHaveProperty('speed', 0);
                expect(c).toHaveProperty('lastActiveTime');
                expect(c).toHaveProperty('splitCount', 0);
            });
        });

        test('should cover entire file range exactly', () => {
            const totalSize = 1500; // odd size to test edge cases
            const chunks = splitChunk(mockDownload, totalSize, 3);
            // Verify no gaps and no overlaps
            expect(chunks[0].startByte).toBe(0);
            for (let i = 1; i < chunks.length; i++) {
                expect(chunks[i].startByte).toBe(chunks[i - 1].endByte + 1);
            }
            expect(chunks[chunks.length - 1].endByte).toBe(totalSize - 1);
        });

        test('should not create more chunks than bytes', () => {
            // Very small file with many threads
            const chunks = splitChunk(mockDownload, 10, 100);
            // With MIN_CHUNK_SIZE at 512KB, should produce exactly 1 chunk
            expect(chunks.length).toBe(1);
            expect(chunks[0].endByte).toBe(9);
        });
    });
});