// Tools - Network, SSL, Cron, Backup
(function() {
  async function runPing() {
    const host = document.getElementById('pingHost').value.trim();
    if (!host) return;
    document.getElementById('pingResult').textContent = 'Pinging...';
    const res = await fetch(`/api/tools/ping?host=${encodeURIComponent(host)}`);
    const data = await res.json();
    document.getElementById('pingResult').textContent = data.output;
  }

  async function runTraceroute() {
    const host = document.getElementById('traceHost').value.trim();
    if (!host) return;
    document.getElementById('traceResult').textContent = 'Tracing...';
    const res = await fetch(`/api/tools/traceroute?host=${encodeURIComponent(host)}`);
    const data = await res.json();
    document.getElementById('traceResult').textContent = data.output;
  }

  async function runDns() {
    const host = document.getElementById('dnsHost').value.trim();
    const type = document.getElementById('dnsType').value;
    if (!host) return;
    document.getElementById('dnsResult').textContent = 'Looking up...';
    const res = await fetch(`/api/tools/dns?host=${encodeURIComponent(host)}&type=${type}`);
    const data = await res.json();
    document.getElementById('dnsResult').textContent = data.result.join('\n');
  }

  async function runPortscan() {
    const host = document.getElementById('portHost').value.trim();
    if (!host) return;
    document.getElementById('portResult').textContent = 'Scanning...';
    const res = await fetch(`/api/tools/portscan?host=${encodeURIComponent(host)}`);
    const data = await res.json();
    document.getElementById('portResult').textContent = data.ports.map(p => `Port ${p.port}: ${p.status}`).join('\n');
  }

  async function loadSSL() {
    const res = await fetch('/api/ssl');
    const certs = await res.json();
    const container = document.getElementById('sslCerts');
    container.innerHTML = certs.map(c => {
      if (c.error) return `<div class="stat-row"><span class="stat-label">${c.domain}</span><span style="color:var(--red)">${c.error}</span></div>`;
      const color = c.daysLeft < 7 ? 'var(--red)' : c.daysLeft < 30 ? 'var(--yellow)' : 'var(--accent)';
      return `
        <div class="stat-row">
          <span class="stat-label">${c.domain}</span>
          <span style="color:${color};font-weight:600">${c.daysLeft} days left</span>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;padding-left:12px">
          Issuer: ${c.issuer} | Expires: ${new Date(c.validTo).toLocaleDateString('id-ID')}
        </div>
      `;
    }).join('');
  }

  async function loadCron() {
    const res = await fetch('/api/cron');
    const data = await res.json();
    const container = document.getElementById('cronJobs');
    let output = '=== User Crontab ===\n' + (data.user || 'No crontab') + '\n\n';
    output += '=== System Crontab ===\n' + (data.system || 'Empty') + '\n';
    if (data.cronD && data.cronD.length) {
      output += '\n=== /etc/cron.d/ ===\n';
      for (const f of data.cronD) output += `\n--- ${f.file} ---\n${f.content}\n`;
    }
    container.textContent = output;
  }

  async function loadBackups() {
    const res = await fetch('/api/backups');
    const backups = await res.json();
    const container = document.getElementById('backupList');
    if (backups.length === 0) {
      container.innerHTML = '<p class="empty-state">No backups yet</p>';
      return;
    }
    container.innerHTML = backups.map(b => `
      <div class="stat-row" style="padding:8px 0;border-bottom:1px solid var(--border-light)">
        <span class="stat-label">${b.name}</span>
        <span style="font-size:12px;color:var(--text-muted)">${formatBytes(b.size)}</span>
        <span style="font-size:11px;color:var(--text-muted)">${new Date(b.created).toLocaleString('id-ID')}</span>
        <button class="proc-btn danger" onclick="window.deleteBackup('${b.name}')">Delete</button>
      </div>
    `).join('');
  }

  async function createBackup() {
    const res = await fetch('/api/backups/create', { method: 'POST' });
    const data = await res.json();
    if (data.ok) { window.showToast('Backup created'); loadBackups(); }
    else window.showToast('Error: ' + data.error, true);
  }

  async function deleteBackup(name) {
    window.showConfirm('Delete backup?', name, async () => {
      await fetch('/api/backups/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      window.showToast('Backup deleted');
      loadBackups();
    });
  }

  window.runPing = runPing;
  window.runTraceroute = runTraceroute;
  window.runDns = runDns;
  window.runPortscan = runPortscan;
  window.loadTools = function() { loadSSL(); loadCron(); loadBackups(); };
  window.createBackup = createBackup;
  window.deleteBackup = deleteBackup;
})();
