// Uptime Monitor
(function() {
  let uptimeChart = null;

  async function loadUptime() {
    try {
      const res = await fetch('/api/uptime/targets');
      const targets = await res.json();

      const container = document.getElementById('uptimeTargets');
      if (targets.length === 0) {
        container.innerHTML = '<p class="empty-state">No targets configured. Click "+ Add Target" to get started.</p>';
        return;
      }

      // Load latest check for each target
      const items = await Promise.all(targets.map(async t => {
        const checksRes = await fetch(`/api/uptime/checks/${t.id}?range=1h`);
        const checks = await checksRes.json();
        const latest = checks.length > 0 ? checks[checks.length - 1] : null;
        return { ...t, latest };
      }));

      container.innerHTML = items.map(t => {
        const status = t.latest ? (t.latest.status >= 200 && t.latest.status < 400 ? 'up' : 'down') : 'unknown';
        const statusText = t.latest ? (status === 'up' ? `UP (${t.latest.status})` : `DOWN (${t.latest.error || t.latest.status})`) : 'No data';
        const latency = t.latest && t.latest.response_ms ? t.latest.response_ms + 'ms' : '-';
        return `
          <div class="uptime-item">
            <span class="uptime-item-name">${t.name}</span>
            <span class="uptime-item-url">${t.url}</span>
            <span class="uptime-item-status ${status}">${statusText}</span>
            <span class="uptime-item-latency">${latency}</span>
            <div class="uptime-item-actions">
              <button class="proc-btn" onclick="window.uptimeCheck(${t.id})">Check</button>
              <button class="proc-btn" onclick="window.uptimeDetails(${t.id},'${t.name}')">History</button>
              <button class="proc-btn danger" onclick="window.uptimeDelete(${t.id},'${t.name}')">✕</button>
            </div>
          </div>
        `;
      }).join('');
    } catch (err) {
      console.error('Uptime load error:', err);
    }
  }

  async function uptimeCheck(id) {
    try {
      const res = await fetch(`/api/uptime/check/${id}`, { method: 'POST' });
      const data = await res.json();
      window.showToast(`Check: ${data.status >= 200 && data.status < 400 ? 'UP' : 'DOWN'} (${data.response_ms}ms)`);
      loadUptime();
    } catch (err) {
      window.showToast(`Error: ${err.message}`, true);
    }
  }

  async function uptimeDetails(id, name) {
    try {
      const res = await fetch(`/api/uptime/checks/${id}?range=24h`);
      const checks = await res.json();

      document.getElementById('uptimeDetailName').textContent = name;
      document.getElementById('uptimeDetailsCard').style.display = 'block';

      // Stats
      const up = checks.filter(c => c.status >= 200 && c.status < 400).length;
      const total = checks.length;
      const uptimePercent = total > 0 ? (up / total * 100).toFixed(2) : 0;
      const avgLatency = total > 0 ? Math.round(checks.reduce((s, c) => s + c.response_ms, 0) / total) : 0;

      document.getElementById('uptimeStats').innerHTML = `
        <div style="display:flex;gap:20px;font-size:13px">
          <div><span style="color:var(--text-muted)">Uptime:</span> <span style="color:var(--accent);font-weight:600">${uptimePercent}%</span></div>
          <div><span style="color:var(--text-muted)">Checks:</span> <span style="font-weight:600">${total}</span></div>
          <div><span style="color:var(--text-muted)">Avg Latency:</span> <span style="font-family:monospace">${avgLatency}ms</span></div>
        </div>
      `;

      // Chart
      const chartData = checks.map(c => ({ x: c.ts * 1000, y: c.response_ms }));
      if (uptimeChart) uptimeChart.destroy();

      const gridColor = getComputedStyle(document.documentElement).getPropertyValue('--chart-grid').trim() || '#1a1a2e';
      const textColor = getComputedStyle(document.documentElement).getPropertyValue('--chart-text').trim() || '#666';

      uptimeChart = new Chart(document.getElementById('uptimeChart'), {
        type: 'line',
        data: {
          datasets: [{
            label: 'Response Time',
            data: chartData,
            borderColor: '#00ff88',
            backgroundColor: 'rgba(0, 255, 136, 0.15)',
            fill: true,
            tension: 0.4,
            pointRadius: 0,
            borderWidth: 2.5,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { type: 'time', time: { tooltipFormat: 'HH:mm' }, grid: { color: gridColor }, ticks: { color: textColor, maxTicksLimit: 8 }, border: { display: false } },
            y: { min: 0, grid: { color: gridColor }, ticks: { color: textColor, callback: v => v + 'ms' }, border: { display: false } },
          },
        },
      });
    } catch (err) {
      console.error('Uptime details error:', err);
    }
  }

  function showAddUptime() {
    document.getElementById('addUptimeDialog').classList.remove('hidden');
  }

  async function addUptimeTarget() {
    const name = document.getElementById('uptimeName').value.trim();
    const url = document.getElementById('uptimeUrl').value.trim();
    if (!name || !url) return window.showToast('Name and URL required', true);

    try {
      const res = await fetch('/api/uptime/targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, url }),
      });
      const data = await res.json();
      if (data.ok) {
        document.getElementById('addUptimeDialog').classList.add('hidden');
        document.getElementById('uptimeName').value = '';
        document.getElementById('uptimeUrl').value = '';
        window.showToast('Target added');
        loadUptime();
      }
    } catch (err) {
      window.showToast(`Error: ${err.message}`, true);
    }
  }

  async function uptimeDelete(id, name) {
    window.showConfirm(
      `Delete ${name}?`,
      'This will remove the target and all its check history.',
      async () => {
        try {
          await fetch(`/api/uptime/targets/${id}`, { method: 'DELETE' });
          window.showToast(`${name} deleted`);
          loadUptime();
        } catch (err) {
          window.showToast(`Error: ${err.message}`, true);
        }
      }
    );
  }

  window.loadUptime = loadUptime;
  window.uptimeCheck = uptimeCheck;
  window.uptimeDetails = uptimeDetails;
  window.showAddUptime = showAddUptime;
  window.addUptimeTarget = addUptimeTarget;
  window.uptimeDelete = uptimeDelete;
})();
