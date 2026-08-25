// Dashboard gauges and real-time updates
(function() {
  const CIRCUMFERENCE = 2 * Math.PI * 52; // gauge circle radius = 52
  let gaugeThresholds = window.missionControlSnapshot?.thresholds || {};

  function setGauge(id, percent) {
    const el = document.getElementById(id);
    if (!el) return;
    const offset = CIRCUMFERENCE - (percent / 100) * CIRCUMFERENCE;
    el.style.strokeDashoffset = offset;
    const metric = id.replace(/Gauge$/, '').toLowerCase();
    const policy = gaugeThresholds[metric] || { attention: 70, incident: 90 };
    if (percent >= Number(policy.incident)) el.style.stroke = 'var(--red)';
    else if (percent >= Number(policy.attention)) el.style.stroke = 'var(--yellow)';
    else el.style.stroke = 'var(--accent)';
  }

  document.addEventListener('vps:missionupdate', event => {
    if (event.detail?.thresholds) gaugeThresholds = event.detail.thresholds;
  });

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

  function createTextElement(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = String(value == null ? '' : value);
    return element;
  }

  function appendStatRow(container, label, value, valueClass = 'stat-value') {
    const row = document.createElement('div');
    row.className = 'stat-row';
    row.append(createTextElement('span', 'stat-label', label), createTextElement('span', valueClass, value));
    container.append(row);
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
      if (diskTable) {
        const rows = disk.filesystems.map(filesystem => {
          const row = document.createElement('tr');
          row.append(
            createTextElement('td', '', filesystem.mount),
            createTextElement('td', 'val', formatBytes(filesystem.size)),
            createTextElement('td', 'val', formatBytes(filesystem.used)),
            createTextElement('td', 'val', formatBytes(filesystem.avail))
          );
          const percent = createTextElement('td', 'val', `${Number(filesystem.percent) || 0}%`);
          percent.style.color = filesystem.percent > 90 ? 'var(--red)' : filesystem.percent > 70 ? 'var(--yellow)' : 'var(--accent)';
          row.append(percent);
          return row;
        });
        diskTable.replaceChildren(...rows);
      }

      // Top dirs
      const dirsTable = document.getElementById('dirsTable');
      if (dirsTable && Array.isArray(disk.topDirs)) {
        const rows = disk.topDirs.map(directory => {
          const row = document.createElement('tr');
          const path = createTextElement('td', '', directory.path);
          path.style.fontSize = '12px';
          row.append(path, createTextElement('td', 'val', directory.size));
          return row;
        });
        dirsTable.replaceChildren(...rows);
      }
    }

    // Services list
    const servicesList = document.getElementById('servicesList');
    const extra = services._extra || {};
    const serviceRows = [];
    for (const [key, val] of Object.entries(services)) {
      if (key === '_extra') continue;
      const row = document.createElement('div');
      row.className = 'service-row';
      row.append(
        createTextElement('span', 'service-name', key),
        createTextElement('span', `service-status ${val.active ? 'active' : 'inactive'}`, val.active ? 'Active' : val.status || 'Inactive')
      );
      serviceRows.push(row);
    }
    // SSH info
    if (extra.ssh_connections !== undefined) {
      const row = document.createElement('div');
      row.className = 'service-row';
      row.append(
        createTextElement('span', 'service-name', 'SSH'),
        createTextElement('span', 'stat-value', `${extra.ssh_connections} connection(s)`)
      );
      serviceRows.push(row);
    }
    if (extra.failed_logins !== undefined) {
      const row = document.createElement('div');
      row.className = 'stat-row';
      row.style.marginTop = '4px';
      const label = createTextElement('span', 'stat-label', 'Failed attempts today');
      label.style.fontSize = '11px';
      const value = createTextElement('span', '', extra.failed_logins);
      value.style.fontSize = '11px';
      value.style.color = extra.failed_logins > 0 ? 'var(--red)' : 'var(--accent)';
      row.append(label, value);
      serviceRows.push(row);
    }
    servicesList?.replaceChildren(...serviceRows);

    // System info
    const sysInfo = document.getElementById('systemInfo');
    if (sysInfo) {
      sysInfo.replaceChildren();
      appendStatRow(sysInfo, 'Kernel', extra.kernel || '-');
      appendStatRow(sysInfo, 'Uptime', extra.uptime || '-');
      appendStatRow(sysInfo, 'Load', extra.load ?? '-');
      appendStatRow(sysInfo, 'Security Updates', `${extra.security_updates || 0} available`);
      appendStatRow(sysInfo, 'Last apt update', extra.last_apt_update || '-');
    }
  });

  // Process preview on dashboard
  socket.on('processes', (procs) => {
    const preview = document.getElementById('procPreview');
    if (!preview) return;
    const rows = (Array.isArray(procs) ? procs : []).slice(0, 5).map(p => {
      const row = document.createElement('tr');
      const pid = document.createElement('td');
      const nameCell = document.createElement('td');
      const name = document.createElement('span');
      const cpu = document.createElement('td');
      const mem = document.createElement('td');
      const statusCell = document.createElement('td');
      const status = document.createElement('span');

      pid.className = 'proc-pid';
      pid.textContent = String(p.pid ?? '—');
      name.className = 'proc-name';
      name.title = String(p.cmd || '');
      name.textContent = String(p.name || 'Unknown');
      nameCell.append(name);
      cpu.className = 'proc-cpu';
      cpu.textContent = `${Number(p.cpu) || 0}%`;
      mem.className = 'proc-mem';
      mem.textContent = `${Number(p.mem) || 0}%`;
      status.className = `proc-status ${String(p.state || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '')}`;
      status.textContent = String(p.state || 'Unknown');
      statusCell.append(status);
      row.append(pid, nameCell, cpu, mem, statusCell);
      return row;
    });
    preview.replaceChildren(...rows);
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
        const warning = createTextElement('span', '', `~${f.disk.days_to_full}d left`);
        warning.style.color = 'var(--yellow)';
        elDisk.replaceChildren(document.createTextNode(`${f.disk.used_pct}% used · `), warning);
      } else {
        elDisk.textContent = `${f.disk.used_pct}% used · ${f.disk.free_gb}GB free`;
      }

      // RAM
      if (f.ram.days_to_exhaustion) {
        const warning = createTextElement('span', '', `~${f.ram.days_to_exhaustion}d left`);
        warning.style.color = 'var(--red)';
        elRam.replaceChildren(document.createTextNode(`${f.ram.used_pct}% · `), warning);
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

  // Load on the explicit page lifecycle instead of observing all class mutations.
  document.addEventListener('vps:pagechange', event => {
    if (event.detail?.page === 'dashboard') loadForecast();
  });
  if (document.getElementById('page-dashboard')?.classList.contains('active')) loadForecast();
  setInterval(loadForecast, 600000); // refresh every 10 min
})();
