// System Log Viewer - journalctl, syslog, app logs
const { exec } = require('child_process');

function runCmd(cmd, timeout = 10000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve(err ? stderr || err.message : stdout);
    });
  });
}

function setupLogRoutes(app, requireAuth) {
  // Available log sources
  app.get('/api/logs/sources', requireAuth, async (req, res) => {
    const sources = [
      { id: 'syslog', name: 'System Log', cmd: 'journalctl --no-pager -n 200' },
      { id: 'auth', name: 'Auth Log', cmd: 'journalctl -u sshd --no-pager -n 200' },
      { id: 'nginx', name: 'Nginx Access', cmd: 'tail -200 /var/log/nginx/access.log 2>/dev/null || echo "No nginx log"' },
      { id: 'nginx-error', name: 'Nginx Error', cmd: 'tail -200 /var/log/nginx/error.log 2>/dev/null || echo "No nginx error log"' },
      { id: 'kern', name: 'Kernel Log', cmd: 'journalctl -k --no-pager -n 200' },
      { id: 'dashboard', name: 'Dashboard App', cmd: 'journalctl -u vps-dashboard --no-pager -n 200' },
      { id: 'cron', name: 'Cron Log', cmd: 'journalctl -t CRON --no-pager -n 200' },
      { id: 'docker', name: 'Docker Log', cmd: 'journalctl -u docker --no-pager -n 200 2>/dev/null || echo "No docker log"' },
    ];
    res.json(sources);
  });

  // Get log content
  app.get('/api/logs/:source', requireAuth, async (req, res) => {
    const { source } = req.params;
    const lines = Math.min(Math.max(parseInt(req.query.lines, 10) || 200, 1), 1000);
    const search = req.query.search || '';

    const sources = {
      syslog: `journalctl --no-pager -n ${lines}`,
      auth: `journalctl -u sshd --no-pager -n ${lines}`,
      nginx: `tail -${lines} /var/log/nginx/access.log 2>/dev/null || echo "No nginx log"`,
      'nginx-error': `tail -${lines} /var/log/nginx/error.log 2>/dev/null || echo "No nginx error log"`,
      kern: `journalctl -k --no-pager -n ${lines}`,
      dashboard: `journalctl -u vps-dashboard --no-pager -n ${lines}`,
      cron: `journalctl -t CRON --no-pager -n ${lines}`,
      docker: `journalctl -u docker --no-pager -n ${lines} 2>/dev/null || echo "No docker log"`,
    };

    const cmd = sources[source];
    if (!cmd) return res.status(400).json({ error: 'Unknown source' });

    let output = await runCmd(cmd);

    // Filter by search term (escape regex to prevent ReDoS)
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Limit regex length to prevent abuse
      const safeRegex = escaped.slice(0, 100);
      try {
        const regex = new RegExp(safeRegex, 'gi');
        output = output.split('\n').filter(line => regex.test(line)).join('\n');
      } catch (e) {
        // Invalid regex — return unfiltered
      }
    }

    res.json({ source, lines: output.split('\n').length, content: output });
  });

  // Live follow (returns last N lines, client polls)
  app.get('/api/logs/:source/follow', requireAuth, async (req, res) => {
    const { source } = req.params;
    const since = req.query.since || '1 min ago';
    const sources = {
      syslog: `journalctl --no-pager --since "${since}"`,
      auth: `journalctl -u sshd --no-pager --since "${since}"`,
      dashboard: `journalctl -u vps-dashboard --no-pager --since "${since}"`,
    };
    const cmd = sources[source];
    if (!cmd) return res.status(400).json({ error: 'Follow not supported for this source' });
    const output = await runCmd(cmd);
    res.json({ content: output });
  });
}

module.exports = { setupLogRoutes };
