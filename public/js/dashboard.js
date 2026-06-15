// Dashboard gauges and real-time updates
(function() {
  const CIRCUMFERENCE = 2 * Math.PI * 52; // gauge circle radius = 52

  function setGauge(id, percent, colorVar) {
    const el = document.getElementById(id);
    if (!el) return;
    const offset = CIRCUMFERENCE - (percent / 100) * CIRCUMFERENCE;
    el.style.strokeDashoffset = offset;
    // Color based on value
    if (percent > 90) el.style.stroke = 'var(--red)';
    else if (percent > 70) el.style.stroke = 'var(--yellow)';
    else el.style.stroke = 'var(--accent)';
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + ' ' + units[i];
  }

  function formatSpeed(bytesPerSec) {
    if (bytesPerSec < 1024) return bytesPerSec + ' B/s';
    if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
    return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
  }

  // Listen for metrics
  socket.on('metrics', (data) => {
    // CPU
    setGauge('cpuGauge', data.cpu);
    document.getElementById('cpuValue').textContent = data.cpu.toFixed(1) + '%';

    // RAM
    setGauge('ramGauge', data.ram_percent);
    document.getElementById('ramValue').textContent = data.ram_percent + '%';
    document.getElementById('ramSub').textContent = formatBytes(data.ram_used) + ' / ' + formatBytes(data.ram_total);

    // Swap
    setGauge('swapGauge', data.swap_percent);
    document.getElementById('swapValue').textContent = data.swap_percent + '%';
    document.getElementById('swapSub').textContent = formatBytes(data.swap_used) + ' / ' + formatBytes(data.swap_total);

    // Network
    document.getElementById('netRx').textContent = formatSpeed(data.net_rx_speed);
    document.getElementById('netTx').textContent = formatSpeed(data.net_tx_speed);
    document.getElementById('tcpCount').textContent = data.net_tcp;
  });

  // Listen for services
  socket.on('services', (data) => {
    const { services, disk } = data;

    // Disk gauge
    if (disk && disk.filesystems) {
      const root = disk.filesystems.find(f => f.mount === '/');
      if (root) {
        setGauge('diskGauge', root.percent);
        document.getElementById('diskValue').textContent = root.percent + '%';
        document.getElementById('diskSub').textContent = formatBytes(root.used) + ' / ' + formatBytes(root.size);
      }

      // Disk table
      const diskTable = document.getElementById('diskTable');
      diskTable.innerHTML = disk.filesystems.map(f => `
        <tr>
          <td>${f.mount}</td>
          <td class="val">${formatBytes(f.size)}</td>
          <td class="val">${formatBytes(f.used)}</td>
          <td class="val">${formatBytes(f.avail)}</td>
          <td class="val" style="color:${f.percent > 90 ? 'var(--red)' : f.percent > 70 ? 'var(--yellow)' : 'var(--accent)'}">${f.percent}%</td>
        </tr>
      `).join('');

      // Top dirs
      const dirsTable = document.getElementById('dirsTable');
      if (disk.topDirs) {
        dirsTable.innerHTML = disk.topDirs.map(d => `
          <tr><td style="font-size:12px">${d.path}</td><td class="val">${d.size}</td></tr>
        `).join('');
      }
    }

    // Services list
    const servicesList = document.getElementById('servicesList');
    const extra = services._extra || {};
    const serviceHtml = [];
    for (const [key, val] of Object.entries(services)) {
      if (key === '_extra') continue;
      serviceHtml.push(`
        <div class="service-row">
          <span class="service-name">${key}</span>
          <span class="service-status ${val.active ? 'active' : 'inactive'}">${val.active ? '✅ Active' : '❌ ' + val.status}</span>
        </div>
      `);
    }
    // SSH info
    if (extra.ssh_connections !== undefined) {
      serviceHtml.push(`
        <div class="service-row">
          <span class="service-name">SSH</span>
          <span class="stat-value">${extra.ssh_connections} connection(s)</span>
        </div>
      `);
    }
    if (extra.failed_logins !== undefined) {
      serviceHtml.push(`
        <div class="stat-row" style="margin-top:4px">
          <span class="stat-label" style="font-size:11px">Failed attempts today</span>
          <span style="font-size:11px;color:${extra.failed_logins > 0 ? 'var(--red)' : 'var(--accent)'}">${extra.failed_logins}</span>
        </div>
      `);
    }
    servicesList.innerHTML = serviceHtml.join('');

    // System info
    const sysInfo = document.getElementById('systemInfo');
    sysInfo.innerHTML = `
      <div class="stat-row"><span class="stat-label">Kernel</span><span class="stat-value">${extra.kernel || '-'}</span></div>
      <div class="stat-row"><span class="stat-label">Uptime</span><span class="stat-value">${extra.uptime || '-'}</span></div>
      <div class="stat-row"><span class="stat-label">Load</span><span class="stat-value">${extra.load || '-'}</span></div>
      <div class="stat-row"><span class="stat-label">Security Updates</span><span class="stat-value" style="color:var(--accent)">${extra.security_updates || 0} available</span></div>
      <div class="stat-row"><span class="stat-label">Last apt update</span><span class="stat-value" style="font-size:11px">${extra.last_apt_update || '-'}</span></div>
    `;
  });

  // Process preview on dashboard
  socket.on('processes', (procs) => {
    const preview = document.getElementById('procPreview');
    preview.innerHTML = procs.slice(0, 5).map(p => `
      <tr>
        <td class="proc-pid">${p.pid}</td>
        <td><span class="proc-name" title="${p.cmd}">${p.name}</span></td>
        <td class="proc-cpu">${p.cpu}%</td>
        <td class="proc-mem">${p.mem}%</td>
        <td><span class="proc-status ${p.state.toLowerCase().replace(' ', '')}">${p.state}</span></td>
      </tr>
    `).join('');
  });

  // Expose formatters
  window.formatBytes = formatBytes;
  window.formatSpeed = formatSpeed;

  // --- Predictive Forecast ---
  async function loadForecast() {
    try {
      const res = await fetch('/api/forecast');
      const f = await res.json();
      if (!f.ready) return;

      const elDisk = document.getElementById('fcDisk');
      const elRam = document.getElementById('fcRam');
      const elCpu = document.getElementById('fcCpu');
      const elDetail = document.getElementById('fcDetail');

      // Disk
      if (f.disk.days_to_full) {
        elDisk.innerHTML = `${f.disk.used_pct}% used · <span style="color:var(--yellow)">~${f.disk.days_to_full}d left</span>`;
      } else {
        elDisk.textContent = `${f.disk.used_pct}% used · ${f.disk.free_gb}GB free`;
      }

      // RAM
      if (f.ram.days_to_exhaustion) {
        elRam.innerHTML = `${f.ram.used_pct}% · <span style="color:var(--red)">~${f.ram.days_to_exhaustion}d left</span>`;
      } else {
        elRam.textContent = `${f.ram.used_pct}% · ${f.ram.trend}`;
      }

      // CPU
      const trendIcon = f.cpu.trend === 'rising' ? '↗️' : f.cpu.trend === 'falling' ? '↘️' : '→';
      elCpu.textContent = `${trendIcon} ${f.cpu.trend} · avg ${f.cpu.avg_30d}%`;

      // Detail line
      const parts = [];
      if (f.disk.r2 >= 30) parts.push(`Disk confidence: ${f.disk.r2}%`);
      if (f.ram.r2 >= 30) parts.push(`RAM confidence: ${f.ram.r2}%`);
      if (parts.length > 0) elDetail.textContent = parts.join(' · ');
    } catch (_) {}
  }

  // Load on dashboard view
  const observer = new MutationObserver(() => {
    const dash = document.getElementById('page-dashboard');
    if (dash && dash.classList.contains('active')) loadForecast();
  });
  observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
  if (document.getElementById('page-dashboard')?.classList.contains('active')) loadForecast();
  setInterval(loadForecast, 600000); // refresh every 10 min
})();
