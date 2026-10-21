const { ipcRenderer } = require('electron');

async function loadStats() {
    const stats = await ipcRenderer.invoke('stats:get');
    const container = document.getElementById('statsContainer');
    container.innerHTML = `
        <div class="col-12 col-md-6 col-lg-4">
            <div class="card p-3">
                <h6>Total Downloads</h6>
                <p class="display-6">${stats.totalCount}</p>
            </div>
        </div>
        <div class="col-12 col-md-6 col-lg-4">
            <div class="card p-3">
                <h6>Completed</h6>
                <p class="display-6">${stats.completed}</p>
            </div>
        </div>
        <div class="col-12 col-md-6 col-lg-4">
            <div class="card p-3">
                <h6>Failed</h6>
                <p class="display-6">${stats.failed}</p>
            </div>
        </div>
    `;

    // Speed chart (last 10 mins)
    const ctx = document.createElement('canvas');
    ctx.id = 'speedChart';
    container.appendChild(ctx);
    new Chart(ctx, {
        type: 'line',
        data: {
            labels: stats.speedHistory.map(p => p.time),
            datasets: [{
                label: 'Total Speed',
                data: stats.speedHistory.map(p => p.speed),
                borderColor: '#4caf50',
                fill: false,
                tension: 0.2
            }]
        },
        options: {
            scales: { y: { beginAtZero: true } },
            plugins: { legend: { display: false } }
        }
    });
}

loadStats();