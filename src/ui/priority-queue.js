const { ipcRenderer } = require('electron');

function renderQueue(queue) {
    const list = document.getElementById('queueList');
    list.innerHTML = queue.map(item => `
        <li class="list-group-item" data-id="${item.id}">
            <i class="me-2 bi bi-grip-vertical"></i>
            ${item.filename}
        </li>`).join('');
}

ipcRenderer.invoke('queue:get').then(renderQueue);

new Sortable(document.getElementById('queueList'), {
    animation: 150,
    onEnd: function (evt) {
        const ids = Array.from(document.querySelectorAll('#queueList li')).map(li => li.dataset.id);
        ipcRenderer.invoke('queue:reorder', ids).then(renderQueue);
    }
});
