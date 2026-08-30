// Backup Scheduler - auto-backup database + config
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function runTar(args) {
  return new Promise((resolve, reject) => {
    execFile('tar', args, { timeout: 60000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
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

function isBackupName(name) {
  return typeof name === 'string' && /^vps-dashboard-backup-[0-9TZ-]+\.tar\.gz$/.test(name);
}

function backupPath(name) {
  if (!isBackupName(name)) throw new Error('Invalid backup name');
  return path.join(BACKUP_DIR, name);
}

function setupBackupRoutes(app, requireAuth, auditLog, config) {
  // List backups
  app.get('/api/backups', requireAuth, (req, res) => {
    try {
      if (!fs.existsSync(BACKUP_DIR)) return res.json([]);
      const files = fs.readdirSync(BACKUP_DIR)
        .filter(isBackupName)
        .map(f => {
          const fullPath = backupPath(f);
          const stats = fs.lstatSync(fullPath);
          if (!stats.isFile()) return null;
          return { name: f, size: stats.size, created: stats.mtime.toISOString() };
        })
        .filter(Boolean)
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
      const backupFile = backupPath(backupName);

      const dbPath = path.resolve(config.dbPath || '/var/lib/vps-dashboard/dashboard.db');
      const dbRelative = path.relative(path.parse(dbPath).root, dbPath);
      const appDir = '/opt/vps-dashboard';

      ensureBackupDir();
      await runTar([
        '-czf', backupFile,
        '-C', path.parse(dbPath).root,
        dbRelative,
        '-C', appDir,
        'config.js',
        'package.json',
      ]);

      if (auditLog) auditLog('backup_create', `Created: ${backupName}`);

      const stats = fs.statSync(backupFile);
      res.json({ ok: true, name: backupName, size: stats.size });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete backup
  app.post('/api/backups/delete', requireAuth, (req, res) => {
    try {
      const backupFile = backupPath(req.body && req.body.name);
      const stats = fs.lstatSync(backupFile);
      if (!stats.isFile()) return res.status(400).json({ error: 'Invalid backup' });
      fs.unlinkSync(backupFile);
      if (auditLog) auditLog('backup_delete', `Deleted: ${path.basename(backupFile)}`);
      res.json({ ok: true });
    } catch (err) {
      const status = err.message === 'Invalid backup name' || err.code === 'ENOENT' ? 400 : 500;
      res.status(status).json({ error: status === 400 ? 'Invalid or missing backup' : err.message });
    }
  });

  // Download backup
  app.get('/api/backups/download/:name', requireAuth, (req, res) => {
    try {
      const backupFile = backupPath(req.params.name);
      const stats = fs.lstatSync(backupFile);
      if (!stats.isFile()) return res.status(400).json({ error: 'Invalid backup' });
      res.download(backupFile);
    } catch (err) {
      const status = err.message === 'Invalid backup name' || err.code === 'ENOENT' ? 400 : 500;
      res.status(status).json({ error: status === 400 ? 'Invalid or missing backup' : err.message });
    }
  });
}

module.exports = { setupBackupRoutes, isBackupName, backupPath };
