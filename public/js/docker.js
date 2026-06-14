// Docker Monitor
(function() {
  let dockerStats = {};

  async function loadDocker() {
    try {
      const availRes = await fetch('/api/docker/available');
      const { available } = await availRes.json();

      if (!available) {
        document.getElementById('dockerNotAvailable').classList.remove('hidden');
        document.getElementById('dockerTable').classList.add('hidden');
        return;
      }

      document.getElementById('dockerNotAvailable').classList.add('hidden');
      document.getElementById('dockerTable').classList.remove('hidden');

      const [containersRes, statsRes] = await Promise.all([
        fetch('/api/docker/containers'),
        fetch('/api/docker/stats'),
      ]);

      const containers = await containersRes.json();
      const stats = await statsRes.json();

      // Index stats by name
      dockerStats = {};
      for (const s of stats) dockerStats[s.name] = s;

      const tbody = document.getElementById('dockerContainers');
      tbody.innerHTML = containers.map(c => {
        const st = dockerStats[c.name] || {};
        const stateClass = c.state.toLowerCase();
        return `
          <tr>
            <td><span class="proc-name">${c.name}</span></td>
            <td style="font-size:12px;color:var(--text-muted)">${c.image}</td>
            <td><span class="docker-status ${stateClass}">${c.state}</span></td>
            <td class="proc-cpu">${st.cpu || '-'}</td>
            <td class="proc-mem">${st.memUsage || '-'}</td>
            <td>
              <div class="proc-actions">
                ${c.state === 'running' ? `
                  <button class="proc-btn" onclick="dockerAction('${c.name}','stop')">Stop</button>
                  <button class="proc-btn" onclick="dockerAction('${c.name}','restart')">Restart</button>
                ` : `
                  <button class="proc-btn" onclick="dockerAction('${c.name}','start')">Start</button>
                `}
                <button class="proc-btn" onclick="dockerLogs('${c.name}')">Logs</button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      console.error('Docker load error:', err);
    }
  }

  async function dockerAction(name, action) {
    try {
      const res = await fetch(`/api/docker/${name}/${action}`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        window.showToast(`${action} ${name} OK`);
        setTimeout(loadDocker, 2000);
      } else {
        window.showToast(`Error: ${data.error}`, true);
      }
    } catch (err) {
      window.showToast(`Error: ${err.message}`, true);
    }
  }

  async function dockerLogs(name) {
    try {
      const res = await fetch(`/api/docker/logs/${name}?lines=200`);
      const data = await res.json();
      document.getElementById('dockerLogName').textContent = name;
      document.getElementById('dockerLogs').textContent = data.logs || 'No logs';
      document.getElementById('dockerLogsCard').style.display = 'block';
    } catch (err) {
      window.showToast(`Error: ${err.message}`, true);
    }
  }

  window.loadDocker = loadDocker;
  window.dockerAction = dockerAction;
  window.dockerLogs = dockerLogs;
})();
