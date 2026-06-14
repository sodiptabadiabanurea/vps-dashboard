// Uptime Monitor - HTTP endpoint checker
const config = require('./config');

let stmts = null;
let io = null;

function initUptimeTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS uptime_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      interval_sec INTEGER DEFAULT 60,
      enabled INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS uptime_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      status INTEGER,
      response_ms INTEGER,
      error TEXT,
      FOREIGN KEY (target_id) REFERENCES uptime_targets(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_uptime_checks_target ON uptime_checks (target_id, ts);
  `);
}

async function checkUrl(url, timeout = 10000) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    return {
      status: res.status,
      response_ms: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      status: 0,
      response_ms: Date.now() - start,
      error: err.message,
    };
  }
}

function startChecker(dbStmts, socketIo) {
  stmts = dbStmts;
  io = socketIo;

  // Check all enabled targets every 60 seconds
  setInterval(async () => {
    const targets = dbStmts.getUptimeTargets.all().filter(t => t.enabled);
    for (const target of targets) {
      const result = await checkUrl(target.url);
      const now = Math.floor(Date.now() / 1000);
      dbStmts.insertUptimeCheck.run(target.id, now, result.status, result.response_ms, result.error);

      // Emit update
      if (io) {
        io.emit('uptime-check', {
          target_id: target.id,
          status: result.status,
          response_ms: result.response_ms,
          error: result.error,
          ts: now,
        });
      }

      // Alert on failure
      if (result.status === 0 || result.status >= 500) {
        const lastOk = dbStmts.getLastUptimeCheck.get(target.id, 200);
        if (!lastOk || lastOk.status !== result.status) {
          const msg = `🔴 Uptime Alert: ${target.name} is DOWN (${result.error || 'HTTP ' + result.status})`;
          if (io) io.emit('alert', { type: 'uptime', message: msg, ts: now });
        }
      }
    }
  }, 60000);

  // Initial check on startup
  setTimeout(async () => {
    const targets = dbStmts.getUptimeTargets.all().filter(t => t.enabled);
    for (const target of targets) {
      const result = await checkUrl(target.url);
      const now = Math.floor(Date.now() / 1000);
      dbStmts.insertUptimeCheck.run(target.id, now, result.status, result.response_ms, result.error);
    }
  }, 5000);
}

function setupUptimeRoutes(app, requireAuth, dbStmts) {
  // List targets
  app.get('/api/uptime/targets', requireAuth, (req, res) => {
    res.json(dbStmts.getUptimeTargets.all());
  });

  // Add target
  app.post('/api/uptime/targets', requireAuth, (req, res) => {
    const { name, url, interval_sec } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'name and url required' });
    const result = dbStmts.insertUptimeTarget.run(name, url, interval_sec || 60, 1);
    res.json({ ok: true, id: result.lastInsertRowid });
  });

  // Update target
  app.put('/api/uptime/targets/:id', requireAuth, (req, res) => {
    const { name, url, interval_sec, enabled } = req.body;
    dbStmts.updateUptimeTarget.run(name, url, interval_sec || 60, enabled ? 1 : 0, parseInt(req.params.id));
    res.json({ ok: true });
  });

  // Delete target
  app.delete('/api/uptime/targets/:id', requireAuth, (req, res) => {
    dbStmts.deleteUptimeTarget.run(parseInt(req.params.id));
    res.json({ ok: true });
  });

  // Get checks for a target
  app.get('/api/uptime/checks/:id', requireAuth, (req, res) => {
    const range = req.query.range || '24h';
    const now = Math.floor(Date.now() / 1000);
    const ranges = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000 };
    const since = now - (ranges[range] || 86400);
    res.json(dbStmts.getUptimeChecks.all(parseInt(req.params.id), since));
  });

  // Manual check
  app.post('/api/uptime/check/:id', requireAuth, async (req, res) => {
    const target = dbStmts.getUptimeTargetById.get(parseInt(req.params.id));
    if (!target) return res.status(404).json({ error: 'Target not found' });
    const result = await checkUrl(target.url);
    const now = Math.floor(Date.now() / 1000);
    dbStmts.insertUptimeCheck.run(target.id, now, result.status, result.response_ms, result.error);
    res.json({ ok: true, ...result });
  });
}

module.exports = { initUptimeTables, startChecker, setupUptimeRoutes };
