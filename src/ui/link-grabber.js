const { ipcRenderer } = require('electron');
const { dialog } = require('@electron/remote'); // Ensure remote is enabled in preload

document.getElementById('loadFileBtn').addEventListener('click', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        filters: [{ name: 'Text Files', extensions: ['txt', 'csv'] }],
        properties: ['openFile']
    });
    if (canceled) return;
    const text = await window.fs.promises.readFile(filePaths[0], 'utf8');
    document.getElementById('urlList').value = text;
});

document.getElementById('importBtn').addEventListener('click', async () => {
    const raw = document.getElementById('urlList').value;
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l);
    const result = await ipcRenderer.invoke('download:import-links', lines);
    alert(`Queued ${result.imported} URLs`);
    // close dialog if needed
    const win = require('electron').remote.getCurrentWindow();
    win.close();
});
