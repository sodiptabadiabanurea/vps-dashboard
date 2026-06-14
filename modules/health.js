// System Health Score + CSV Export

function calculateHealthScore(metrics, diskData, securityData) {
  let score = 100;
  const issues = [];

  // CPU (max -20)
  if (metrics.cpu > 90) { score -= 20; issues.push({ severity: 'critical', msg: `CPU at ${metrics.cpu}%` }); }
  else if (metrics.cpu > 70) { score -= 10; issues.push({ severity: 'warning', msg: `CPU at ${metrics.cpu}%` }); }
  else if (metrics.cpu > 50) { score -= 5; }

  // RAM (max -20)
  const ramPct = metrics.ram_percent || 0;
  if (ramPct > 90) { score -= 20; issues.push({ severity: 'critical', msg: `RAM at ${ramPct}%` }); }
  else if (ramPct > 80) { score -= 10; issues.push({ severity: 'warning', msg: `RAM at ${ramPct}%` }); }
  else if (ramPct > 60) { score -= 5; }

  // Swap (max -10)
  const swapPct = metrics.swap_percent || 0;
  if (swapPct > 50) { score -= 10; issues.push({ severity: 'warning', msg: `Swap at ${swapPct}%` }); }
  else if (swapPct > 20) { score -= 5; }

  // Disk (max -15)
  if (diskData && diskData.filesystems) {
    const root = diskData.filesystems.find(f => f.mount === '/');
    if (root) {
      if (root.percent > 90) { score -= 15; issues.push({ severity: 'critical', msg: `Disk at ${root.percent}%` }); }
      else if (root.percent > 80) { score -= 8; issues.push({ severity: 'warning', msg: `Disk at ${root.percent}%` }); }
    }
  }

  // Security (max -15)
  if (securityData) {
    if (securityData.failed_logins > 10) { score -= 10; issues.push({ severity: 'warning', msg: `${securityData.failed_logins} failed logins today` }); }
    if (securityData.security_updates > 0) { score -= 5; issues.push({ severity: 'info', msg: `${securityData.security_updates} security updates available` }); }
  }

  // Load average (max -10)
  const load = metrics.load || 0;
  const cores = metrics.cores || 1;
  if (load > cores * 2) { score -= 10; issues.push({ severity: 'warning', msg: `Load ${load} (cores: ${cores})` }); }
  else if (load > cores) { score -= 5; }

  score = Math.max(0, Math.min(100, score));

  let grade = 'A';
  if (score < 60) grade = 'F';
  else if (score < 70) grade = 'D';
  else if (score < 80) grade = 'C';
  else if (score < 90) grade = 'B';

  return { score, grade, issues };
}

function metricsToCsv(rows) {
  if (!rows || rows.length === 0) return 'No data';
  const headers = ['timestamp', 'cpu', 'ram_used', 'ram_total', 'swap_used', 'swap_total', 'disk_used', 'disk_total', 'net_rx', 'net_tx'];
  const csv = [headers.join(',')];
  for (const r of rows) {
    csv.push([
      new Date(r.ts * 1000).toISOString(),
      r.cpu, r.ram_used, r.ram_total, r.swap_used, r.swap_total,
      r.disk_used, r.disk_total, r.net_rx, r.net_tx
    ].join(','));
  }
  return csv.join('\n');
}

function setupHealthRoutes(app, requireAuth, stmts) {
  // Health score
  app.get('/api/health', requireAuth, (req, res) => {
    const metrics = req.app.locals.lastMetrics || {};
    const disk = req.app.locals.lastDisk || {};
    const services = req.app.locals.lastServices || {};
    const extra = services._extra || {};
    const health = calculateHealthScore(metrics, disk, extra);
    res.json(health);
  });

  // CSV export
  app.get('/api/export/csv', requireAuth, (req, res) => {
    const range = req.query.range || '24h';
    const now = Math.floor(Date.now() / 1000);
    const ranges = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000 };
    const since = now - (ranges[range] || 86400);
    const rows = stmts.getHistory.all(since);
    const csv = metricsToCsv(rows);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=vps-metrics-${range}.csv`);
    res.send(csv);
  });
}

module.exports = { calculateHealthScore, metricsToCsv, setupHealthRoutes };
