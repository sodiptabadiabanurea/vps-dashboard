// System Log Viewer
(function() {
  async function loadLogs() {
    const source = document.getElementById('logSource').value;
    const search = document.getElementById('logSearch').value.trim();
    const container = document.getElementById('logContent');
    container.textContent = 'Loading...';

    try {
      const url = `/api/logs/${source}?lines=500` + (search ? `&search=${encodeURIComponent(search)}` : '');
      const res = await fetch(url);
      const data = await res.json();
      container.textContent = data.content || 'No logs';
      container.scrollTop = container.scrollHeight;
    } catch (err) {
      container.textContent = 'Error: ' + err.message;
    }
  }

  // Auto-refresh every 10s when on logs page
  let logInterval = null;

  window.loadLogs = loadLogs;
  window.startLogFollow = function() {
    if (logInterval) clearInterval(logInterval);
    logInterval = setInterval(loadLogs, 10000);
  };
  window.stopLogFollow = function() {
    if (logInterval) { clearInterval(logInterval); logInterval = null; }
  };
})();
