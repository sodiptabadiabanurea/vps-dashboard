const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(config.dbPath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// --- Schema ---
db.exec(`
  CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    cpu REAL,
    ram_used INTEGER,
    ram_total INTEGER,
    swap_used INTEGER,
    swap_total INTEGER,
    disk_used INTEGER,
    disk_total INTEGER,
    net_rx INTEGER,
    net_tx INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics (ts);

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    value REAL,
    threshold REAL
  );

  CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts (ts);

  CREATE TABLE IF NOT EXISTS alert_config (
    type TEXT PRIMARY KEY,
    enabled INTEGER DEFAULT 1,
    threshold REAL NOT NULL,
    cooldown INTEGER DEFAULT 300
  );

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

// --- Seed alert config from defaults ---
const upsertAlert = db.prepare(`
  INSERT OR IGNORE INTO alert_config (type, enabled, threshold, cooldown)
  VALUES (?, ?, ?, ?)
`);

for (const [type, cfg] of Object.entries(config.alerts)) {
  upsertAlert.run(type, cfg.enabled ? 1 : 0, cfg.threshold, cfg.cooldown);
}

// --- Prepared statements ---
const stmts = {
  insertMetric: db.prepare(`
    INSERT INTO metrics (ts, cpu, ram_used, ram_total, swap_used, swap_total, disk_used, disk_total, net_rx, net_tx)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  getHistory: db.prepare(`
    SELECT * FROM metrics WHERE ts >= ? ORDER BY ts ASC
  `),

  insertAlert: db.prepare(`
    INSERT INTO alerts (ts, type, message, value, threshold)
    VALUES (?, ?, ?, ?, ?)
  `),

  getAlerts: db.prepare(`
    SELECT * FROM alerts ORDER BY ts DESC LIMIT ?
  `),

  getAlertConfig: db.prepare(`
    SELECT * FROM alert_config
  `),

  updateAlertConfig: db.prepare(`
    UPDATE alert_config SET enabled = ?, threshold = ?, cooldown = ? WHERE type = ?
  `),

  deleteOldMetrics: db.prepare(`
    DELETE FROM metrics WHERE ts < ?
  `),

  deleteOldAlerts: db.prepare(`
    DELETE FROM alerts WHERE ts < ?
  `),

  // Uptime statements
  getUptimeTargets: db.prepare(`SELECT * FROM uptime_targets ORDER BY id`),
  getUptimeTargetById: db.prepare(`SELECT * FROM uptime_targets WHERE id = ?`),
  insertUptimeTarget: db.prepare(`INSERT INTO uptime_targets (name, url, interval_sec, enabled) VALUES (?, ?, ?, ?)`),
  updateUptimeTarget: db.prepare(`UPDATE uptime_targets SET name = ?, url = ?, interval_sec = ?, enabled = ? WHERE id = ?`),
  deleteUptimeTarget: db.prepare(`DELETE FROM uptime_targets WHERE id = ?`),
  insertUptimeCheck: db.prepare(`INSERT INTO uptime_checks (target_id, ts, status, response_ms, error) VALUES (?, ?, ?, ?, ?)`),
  getUptimeChecks: db.prepare(`SELECT * FROM uptime_checks WHERE target_id = ? AND ts >= ? ORDER BY ts ASC`),
  getLastUptimeCheck: db.prepare(`SELECT * FROM uptime_checks WHERE target_id = ? AND status = ? ORDER BY ts DESC LIMIT 1`),
};

// --- Cleanup old data periodically ---
function cleanup() {
  const cutoff = Math.floor(Date.now() / 1000) - (config.historyRetentionDays * 86400);
  stmts.deleteOldMetrics.run(cutoff);
  stmts.deleteOldAlerts.run(cutoff);
}
setInterval(cleanup, 3600000); // every hour
cleanup();

module.exports = { db, stmts };
