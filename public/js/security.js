// Security - Health Score, Fail2ban, Login History, Audit Log, 2FA, Notifications
(function() {
  async function loadHealth() {
    try {
      const res = await fetch('/api/health');
      const health = await res.json();
      const container = document.getElementById('healthScore');
      const color = health.score >= 90 ? 'var(--accent)' : health.score >= 70 ? 'var(--yellow)' : 'var(--red)';
      container.innerHTML = `
        <div style="font-size:72px;font-weight:700;color:${color};font-family:monospace">${health.score}</div>
        <div style="font-size:18px;font-weight:600;color:${color};margin-top:4px">Grade: ${health.grade}</div>
        ${health.issues.length > 0 ? `
          <div style="margin-top:16px;text-align:left;max-width:400px;margin-left:auto;margin-right:auto">
            ${health.issues.map(i => `<div style="font-size:13px;color:var(--text-secondary);padding:4px 0">• ${i.msg}</div>`).join('')}
          </div>
        ` : '<div style="margin-top:8px;color:var(--accent);font-size:14px">All systems healthy! ✅</div>'}
        <a href="/api/export/csv?range=24h" download style="display:inline-block;margin-top:16px;color:var(--accent);font-size:13px;text-decoration:none">📥 Export Metrics CSV</a>
      `;
    } catch (err) { console.error('Health load error:', err); }
  }

  async function loadFail2ban() {
    try {
      const availRes = await fetch('/api/fail2ban/available');
      const { available } = await availRes.json();
      const container = document.getElementById('fail2banStatus');

      if (!available) {
        container.innerHTML = '<p class="empty-state">Fail2ban not installed</p>';
        return;
      }

      const jailsRes = await fetch('/api/fail2ban/jails');
      const { jails } = await jailsRes.json();

      if (jails.length === 0) {
        container.innerHTML = '<p class="empty-state">No jails configured</p>';
        return;
      }

      let html = '';
      for (const jail of jails) {
        const res = await fetch(`/api/fail2ban/jail/${jail}`);
        const data = await res.json();
        html += `<h3 style="font-size:13px;color:var(--accent);margin:12px 0 8px">${jail} (${data.totalBanned} banned, ${data.totalFailed} failed)</h3>`;
        if (data.bannedIps.length > 0) {
          html += data.bannedIps.map(ip => `
            <div class="stat-row" style="padding:4px 0">
              <span class="stat-label" style="font-family:monospace">${ip}</span>
              <button class="proc-btn" onclick="window.unbanIp('${ip}','${jail}')">Unban</button>
            </div>
          `).join('');
        } else {
          html += '<div style="font-size:12px;color:var(--text-muted);padding:4px 0">No banned IPs</div>';
        }
      }
      container.innerHTML = html;
    } catch (err) { console.error('Fail2ban error:', err); }
  }

  async function unbanIp(ip, jail) {
    await fetch('/api/fail2ban/unban', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip, jail }) });
    window.showToast(`Unbanned ${ip}`);
    loadFail2ban();
  }

  async function loadLoginHistory() {
    const res = await fetch('/api/audit/logins?limit=50');
    const logins = await res.json();
    const container = document.getElementById('loginHistory');
    if (logins.length === 0) { container.innerHTML = '<p class="empty-state">No login history</p>'; return; }
    container.innerHTML = logins.map(l => `
      <div class="stat-row" style="padding:4px 0;font-size:12px">
        <span style="color:${l.success ? 'var(--accent)' : 'var(--red)'}">${l.success ? '✅' : '❌'}</span>
        <span style="color:var(--text-muted)">${new Date(l.ts * 1000).toLocaleString('id-ID')}</span>
        <span style="font-family:monospace">${l.ip || '-'}</span>
      </div>
    `).join('');
  }

  async function loadAuditLog() {
    const res = await fetch('/api/audit/actions?limit=50');
    const actions = await res.json();
    const container = document.getElementById('auditLog');
    if (actions.length === 0) { container.innerHTML = '<p class="empty-state">No audit log</p>'; return; }
    container.innerHTML = actions.map(a => `
      <div class="stat-row" style="padding:4px 0;font-size:12px">
        <span style="color:var(--accent);min-width:120px">${a.action}</span>
        <span style="flex:1;color:var(--text-secondary)">${a.detail || '-'}</span>
        <span style="color:var(--text-muted)">${new Date(a.ts * 1000).toLocaleString('id-ID')}</span>
      </div>
    `).join('');
  }

  async function load2FA() {
    const res = await fetch('/api/2fa/status');
    const status = await res.json();
    const container = document.getElementById('twoFAStatus');
    if (status.enabled) {
      container.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px">
          <span style="color:var(--accent);font-weight:600">✅ 2FA is enabled</span>
          <button class="btn btn-ghost" onclick="window.disable2FA()">Disable</button>
        </div>
      `;
    } else {
      container.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px">
          <span style="color:var(--text-muted)">2FA is disabled</span>
          <button class="btn btn-ghost" onclick="window.enable2FA()">Enable</button>
        </div>
      `;
    }
  }

  async function enable2FA() {
    const res = await fetch('/api/2fa/enable', { method: 'POST' });
    const data = await res.json();
    window.showConfirm('Scan QR Code', `Secret: ${data.secret}\n\nUse Google Authenticator or similar app.`, () => {});
    const token = prompt('Enter 6-digit code from your authenticator:');
    if (!token) return;
    const verifyRes = await fetch('/api/2fa/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const verifyData = await verifyRes.json();
    if (verifyData.verified) { window.showToast('2FA enabled!'); load2FA(); }
    else window.showToast('Invalid code', true);
  }

  async function disable2FA() {
    await fetch('/api/2fa/disable', { method: 'POST' });
    window.showToast('2FA disabled');
    load2FA();
  }

  async function loadNotifications() {
    const res = await fetch('/api/notifications/config');
    const channels = await res.json();
    const container = document.getElementById('notifChannels');
    container.innerHTML = channels.map(ch => `
      <div class="alert-row" style="margin-bottom:8px">
        <span class="alert-row-label" style="min-width:80px;text-transform:capitalize">${ch.type}</span>
        <div class="alert-row-controls">
          <div class="toggle ${ch.enabled ? 'active' : ''}" onclick="window.toggleNotif('${ch.type}', this)"></div>
          <input type="text" class="search-input" style="flex:1" value="${ch.webhook_url}" placeholder="Webhook URL or token:chatid" onchange="window.updateNotifUrl('${ch.type}', this.value)">
          <button class="proc-btn" onclick="window.testNotif('${ch.type}')">Test</button>
        </div>
      </div>
    `).join('');
  }

  async function toggleNotif(type, el) {
    const enabled = !el.classList.contains('active');
    const row = el.closest('.alert-row');
    const url = row.querySelector('input').value;
    await fetch(`/api/notifications/${type}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled, webhook_url: url }) });
    el.classList.toggle('active');
  }

  async function updateNotifUrl(type, url) {
    await fetch(`/api/notifications/${type}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ webhook_url: url }) });
  }

  async function testNotif(type) {
    const res = await fetch(`/api/notifications/${type}/test`, { method: 'POST' });
    const data = await res.json();
    window.showToast(data.ok ? 'Test sent!' : 'Error: ' + data.error, !data.ok);
  }

  window.loadSecurity = function() { loadHealth(); loadFail2ban(); loadLoginHistory(); loadAuditLog(); load2FA(); loadNotifications(); };
  window.unbanIp = unbanIp;
  window.enable2FA = enable2FA;
  window.disable2FA = disable2FA;
  window.toggleNotif = toggleNotif;
  window.updateNotifUrl = updateNotifUrl;
  window.testNotif = testNotif;
})();
