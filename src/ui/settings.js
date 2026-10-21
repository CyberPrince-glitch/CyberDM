const { ipcRenderer } = require('electron');

async function loadSettings() {
    const settings = await ipcRenderer.invoke('settings:get');
    document.getElementById('setting-path').value = settings.downloadPath || '';
    document.getElementById('setting-threads').value = settings.maxConcurrent || 3;
    document.getElementById('setting-speed').value = settings.speedLimit || 0;
    document.getElementById('setting-conflict-mode').value = settings.fileConflictMode || 'ask';
}

async function saveSettings() {
    const newSettings = {
        downloadPath: document.getElementById('setting-path').value,
        maxConcurrent: parseInt(document.getElementById('setting-threads').value, 10),
        speedLimit: parseInt(document.getElementById('setting-speed').value, 10),
        fileConflictMode: document.getElementById('setting-conflict-mode').value
    };
    await ipcRenderer.invoke('settings:set', newSettings);
    alert('Settings saved');
}

loadSettings();