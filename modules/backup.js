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

const BACKUP_DIR = process.env.BACKUP_DIR || '/var/lib/vps-dashboard/backups';

// Validate backup name — reject traversal, absolute paths, null bytes
function isValidBackupName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.includes('..') || name.includes('\0')) return false;
  if (path.isAbsolute(name)) return false;
  // Must end with .tar.gz and contain only safe chars
  if (!/^[\w.-]+\.tar\.gz$/.test(name)) return false;
  return true;
}

function setupBackupRoutes(app, requireAuth, auditLog, config) {
  // Ensure backup dir exists
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

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
      res.status(500).json({ error: 'Failed to list backups' });
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

      await runCmd(`tar -czf ${backupPath} -C / ${dbPath.replace('/', '')} -C ${appDir} config.js package.json 2>/dev/null || true`);

      if (auditLog) auditLog('backup_create', `Created: ${backupName}`);

      const stats = fs.statSync(backupPath);
      res.json({ ok: true, name: backupName, size: stats.size });
    } catch (err) {
      res.status(500).json({ error: 'Failed to create backup' });
    }
  });

  // Delete backup
  app.post('/api/backups/delete', requireAuth, (req, res) => {
    try {
      const { name } = req.body;
      if (!isValidBackupName(name)) return res.status(400).json({ error: 'Invalid backup name' });
      const backupPath = path.join(BACKUP_DIR, path.basename(name));
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      if (auditLog) auditLog('backup_delete', `Deleted: ${name}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete backup' });
    }
  });

  // Download backup
  app.get('/api/backups/download/:name', requireAuth, (req, res) => {
    const name = req.params.name;
    if (!isValidBackupName(name)) return res.status(400).json({ error: 'Invalid backup name' });
    const backupPath = path.join(BACKUP_DIR, path.basename(name));
    if (!fs.existsSync(backupPath)) return res.status(404).json({ error: 'Not found' });
    res.download(backupPath);
  });
}

module.exports = { setupBackupRoutes };
