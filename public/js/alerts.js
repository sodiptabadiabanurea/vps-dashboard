// Alert configuration and history
(function() {
  const labels = { cpu: 'CPU', ram: 'RAM', disk: 'Disk', swap: 'Swap' };

  async function loadAlertConfig() {
    try {
      const res = await fetch('/api/alerts/config');
      const configs = await res.json();

      const container = document.getElementById('alertConfig');
      container.innerHTML = configs.map(c => `
        <div class="alert-row" data-type="${c.type}">
          <span class="alert-row-label">${labels[c.type] || c.type}</span>
          <div class="alert-row-controls">
            <div class="toggle ${c.enabled ? 'active' : ''}" onclick="window.toggleAlert('${c.type}', this)"></div>
            <span style="color:var(--text-muted);font-size:13px">Threshold:</span>
            <input type="number" class="threshold-input" value="${c.threshold}" min="1" max="100"
              onchange="window.updateThreshold('${c.type}', this.value)">
            <span style="color:var(--text-muted);font-size:13px">%</span>
          </div>
        </div>
      `).join('');
    } catch (err) {
      console.error('Alert config load error:', err);
    }
  }

  async function loadAlertHistory() {
    try {
      const res = await fetch('/api/alerts?limit=50');
      const alerts = await res.json();

      const container = document.getElementById('alertHistory');
      if (alerts.length === 0) {
        container.innerHTML = '<p class="empty-state">No alerts triggered yet</p>';
        return;
      }

      container.innerHTML = alerts.map(a => {
        const date = new Date(a.ts * 1000);
        return `
          <div class="alert-item">
            <span class="alert-item-icon">⚠️</span>
            <span class="alert-item-text">${a.message}</span>
            <span class="alert-item-time">${date.toLocaleString('id-ID')}</span>
          </div>
        `;
      }).join('');
    } catch (err) {
      console.error('Alert history load error:', err);
    }
  }

  // Toggle alert
  window.toggleAlert = async function(type, el) {
    const isActive = el.classList.contains('active');
    const row = el.closest('.alert-row');
    const threshold = row.querySelector('.threshold-input').value;

    try {
      await fetch(`/api/alerts/config/${type}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !isActive, threshold: parseFloat(threshold), cooldown: 300 }),
      });
      el.classList.toggle('active');
    } catch (err) {
      console.error('Toggle alert error:', err);
    }
  };

  // Update threshold
  window.updateThreshold = async function(type, value) {
    const row = document.querySelector(`.alert-row[data-type="${type}"]`);
    const enabled = row.querySelector('.toggle').classList.contains('active');

    try {
      await fetch(`/api/alerts/config/${type}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, threshold: parseFloat(value), cooldown: 300 }),
      });
    } catch (err) {
      console.error('Update threshold error:', err);
    }
  };

  // Listen for real-time alerts
  socket.on('alert', (data) => {
    const toast = document.getElementById('alertToast');
    const text = document.getElementById('alertToastText');
    text.textContent = data.message;
    toast.classList.remove('hidden');

    // Auto-hide after 10s
    setTimeout(() => toast.classList.add('hidden'), 10000);

    // Update badge
    const badge = document.getElementById('alertBadge');
    const count = parseInt(badge.textContent, 10) || 0;
    badge.textContent = count + 1;
    badge.classList.remove('hidden');
  });

  // Close alert toast
  document.getElementById('alertToastClose')?.addEventListener('click', () => {
    document.getElementById('alertToast').classList.add('hidden');
  });

  // Load on page switch
  window.loadAlerts = function() {
    loadAlertConfig();
    loadAlertHistory();
  };
})();
