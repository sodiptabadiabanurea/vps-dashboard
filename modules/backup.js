// Backup Scheduler - auto-backup database + config
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

function runCmd(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

// Derive the backup dir from the DB location unless explicitly overridden,
// and never create it at module load: startup must not fail (or touch
// protected paths) just because backups have never been requested.
const BACKUP_DIR = process.env.BACKUP_DIR
  || path.join(path.dirname(process.env.DB_PATH || '/var/lib/vps-dashboard/dashboard.db'), 'backups');

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function setupBackupRoutes(app, requireAuth, auditLog, config) {
  // List backups
  app.get('/api/backups', requireAuth, (req, res) => {
    try {
      if (!fs.existsSync(BACKUP_DIR)) return res.json([]);
      const files = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.endsWith('.tar.gz'))
        .map(f => {
          const stats = fs.statSync(path.join(BACKUP_DIR, f));
          return { name: f, size: stats.size, created: stats.mtime.toISOString() };
        })
        .sort((a, b) => new Date(b.created) - new Date(a.created));
      res.json(files);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create backup
  app.post('/api/backups/create', requireAuth, async (req, res) => {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupName = `vps-dashboard-backup-${timestamp}.tar.gz`;
      const backupPath = path.join(BACKUP_DIR, backupName);

      const dbPath = config.dbPath || '/var/lib/vps-dashboard/dashboard.db';
      const appDir = '/opt/vps-dashboard';

      ensureBackupDir();
      await runCmd(`tar -czf ${backupPath} -C / ${dbPath.replace('/', '')} -C ${appDir} config.js package.json 2>/dev/null || true`);

      if (auditLog) auditLog('backup_create', `Created: ${backupName}`);

      const stats = fs.statSync(backupPath);
      res.json({ ok: true, name: backupName, size: stats.size });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete backup
  app.post('/api/backups/delete', requireAuth, (req, res) => {
    try {
      const { name } = req.body;
      if (!name || name.includes('..')) return res.status(400).json({ error: 'Invalid name' });
      const backupPath = path.join(BACKUP_DIR, name);
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      if (auditLog) auditLog('backup_delete', `Deleted: ${name}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Download backup
  app.get('/api/backups/download/:name', requireAuth, (req, res) => {
    const name = req.params.name;
    if (name.includes('..')) return res.status(400).json({ error: 'Invalid name' });
    const backupPath = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(backupPath)) return res.status(404).json({ error: 'Not found' });
    res.download(backupPath);
  });
}

module.exports = { setupBackupRoutes };
