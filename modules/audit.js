// Login History + Audit Log - track all actions
const config = require('../config');

let stmts = null;

function initAuditTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS login_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT,
      success INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      ip TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_login_ts ON login_history (ts);
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts);
  `);
}

function initAudit(dbStmts) {
  stmts = dbStmts;
}

function logLogin(ip, userAgent, success) {
  if (!stmts) return;
  stmts.insertLogin.run(Math.floor(Date.now() / 1000), ip, userAgent || '', success ? 1 : 0);
}

function auditLog(action, detail, ip) {
  if (!stmts) return;
  stmts.insertAudit.run(Math.floor(Date.now() / 1000), action, detail || '', ip || '');
}

function setupAuditRoutes(app, requireAuth) {
  // Login history
  app.get('/api/audit/logins', requireAuth, (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 100;
    res.json(stmts.getLogins.all(limit));
  });

  // Audit log
  app.get('/api/audit/actions', requireAuth, (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 100;
    res.json(stmts.getAudits.all(limit));
  });

  // Clear old logs (keep last 30 days)
  app.post('/api/audit/cleanup', requireAuth, (req, res) => {
    const cutoff = Math.floor(Date.now() / 1000) - (30 * 86400);
    stmts.deleteOldLogins.run(cutoff);
    stmts.deleteOldAudits.run(cutoff);
    res.json({ ok: true });
  });
}

module.exports = { initAuditTables, initAudit, logLogin, auditLog, setupAuditRoutes };
