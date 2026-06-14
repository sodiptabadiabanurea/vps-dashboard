// Process manager
(function() {
  let allProcesses = [];

  function renderProcessRow(p, full) {
    const rss = window.formatBytes ? window.formatBytes(p.rss) : (p.rss / 1024 / 1024).toFixed(0) + ' MB';
    const stateClass = p.state.toLowerCase().replace(' ', '');
    return `
      <tr>
        <td class="proc-pid">${p.pid}</td>
        <td><span class="proc-name" title="${p.cmd}">${p.name}</span></td>
        <td class="proc-cpu">${p.cpu}%</td>
        <td class="proc-mem">${p.mem}%</td>
        ${full ? `<td class="proc-mem">${rss}</td>` : ''}
        <td><span class="proc-status ${stateClass}">${p.state}</span></td>
        ${full ? `<td style="font-size:11px;color:var(--text-muted)">${p.uptime}</td>` : ''}
        ${full ? `
          <td>
            <div class="proc-actions full">
              <button class="proc-btn" onclick="window.killProcess(${p.pid}, '${p.name}', false)" title="Kill (SIGTERM)">Kill</button>
              <button class="proc-btn danger" onclick="window.killProcess(${p.pid}, '${p.name}', true)" title="Force kill (SIGKILL)">Force</button>
            </div>
          </td>
        ` : ''}
      </tr>
    `;
  }

  function renderProcessTable() {
    const search = document.getElementById('procSearch')?.value?.toLowerCase() || '';
    const sortBy = document.getElementById('procSort')?.value || 'cpu';

    let filtered = allProcesses.filter(p =>
      p.name.toLowerCase().includes(search) ||
      p.cmd.toLowerCase().includes(search) ||
      String(p.pid).includes(search)
    );

    filtered.sort((a, b) => {
      if (sortBy === 'cpu') return b.cpu - a.cpu;
      if (sortBy === 'mem') return b.mem - a.mem;
      if (sortBy === 'pid') return a.pid - b.pid;
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      return 0;
    });

    const procFull = document.getElementById('procFull');
    if (procFull) {
      procFull.innerHTML = filtered.map(p => renderProcessRow(p, true)).join('');
    }
  }

  // Listen for process updates
  socket.on('processes', (procs) => {
    allProcesses = procs;
    renderProcessTable();
  });

  // Search and sort handlers
  document.getElementById('procSearch')?.addEventListener('input', renderProcessTable);
  document.getElementById('procSort')?.addEventListener('change', renderProcessTable);

  // Kill process
  window.killProcess = function(pid, name, force) {
    window.showConfirm(
      `Kill ${name} (PID ${pid})?`,
      force ? 'This will forcefully terminate the process (SIGKILL).' : 'This will send SIGTERM to the process.',
      async () => {
        try {
          const endpoint = force ? 'kill-force' : 'kill';
          const res = await fetch(`/api/processes/${pid}/${endpoint}`, { method: 'POST' });
          const data = await res.json();
          if (data.ok) {
            window.showToast(`Process ${pid} terminated`);
          } else {
            window.showToast(`Error: ${data.error}`, true);
          }
        } catch (err) {
          window.showToast(`Error: ${err.message}`, true);
        }
      }
    );
  };
})();
