const { ipcRenderer } = require('electron');

async function testDownload() {
    console.log('Testing download system...');
    
    // Test 1: Regular file download
    try {
        const result = await ipcRenderer.invoke('download:start', {
            url: 'https://www.google.com/favicon.ico',
            savePath: null,
            options: { filename: 'test-favicon.ico', threads: 4 }
        });
        console.log('Test 1 - Regular download:', result.success ? 'PASS' : 'FAIL', result.error || '');
    } catch (e) {
        console.log('Test 1 - Regular download: FAIL', e.message);
    }
    
    // Test 2: Settings sanitization
    try {
        const settings = await ipcRenderer.invoke('settings:get');
        console.log('Test 2 - Settings loaded:', settings ? 'PASS' : 'FAIL');
        console.log('  connectionTimeout:', settings.connectionTimeout);
    } catch (e) {
        console.log('Test 2 - Settings: FAIL', e.message);
    }
}

testDownload();
