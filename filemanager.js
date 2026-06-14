// File Manager - browse, upload, download, edit, delete files
const fs = require('fs');
const path = require('path');
const os = require('os');
const multer = require('multer');

const ROOT = process.env.FM_ROOT || os.homedir();

// Safe path resolution - prevent traversal
function safePath(requestedPath) {
  const resolved = path.resolve(ROOT, requestedPath || '');
  if (!resolved.startsWith(ROOT)) throw new Error('Access denied');
  return resolved;
}

function setupFileManagerRoutes(app, requireAuth) {
  const upload = multer({ dest: '/tmp/vps-dashboard-uploads/' });

  // List directory
  app.get('/api/files', requireAuth, (req, res) => {
    try {
      const dirPath = safePath(req.query.path || '');
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const items = entries.map(entry => {
        const fullPath = path.join(dirPath, entry.name);
        let stats;
        try { stats = fs.statSync(fullPath); } catch { stats = null; }
        return {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: stats ? stats.size : 0,
          modified: stats ? stats.mtime.toISOString() : null,
          permissions: stats ? (stats.mode & 0o777).toString(8) : null,
          path: path.relative(ROOT, fullPath),
        };
      });
      // Sort: directories first, then by name
      items.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      res.json({ path: path.relative(ROOT, dirPath), items });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // Read file
  app.get('/api/files/read', requireAuth, (req, res) => {
    try {
      const filePath = safePath(req.query.path);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
      const stats = fs.statSync(filePath);
      if (stats.size > 5 * 1024 * 1024) return res.status(400).json({ error: 'File too large (>5MB)' });
      const content = fs.readFileSync(filePath, 'utf8');
      res.json({ content, size: stats.size, path: path.relative(ROOT, filePath) });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // Write file
  app.post('/api/files/write', requireAuth, (req, res) => {
    try {
      const filePath = safePath(req.body.path);
      fs.writeFileSync(filePath, req.body.content || '', 'utf8');
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // Delete file/directory
  app.post('/api/files/delete', requireAuth, (req, res) => {
    try {
      const filePath = safePath(req.body.path);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
      const stats = fs.statSync(filePath);
      if (stats.isDirectory()) {
        fs.rmSync(filePath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(filePath);
      }
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // Create directory
  app.post('/api/files/mkdir', requireAuth, (req, res) => {
    try {
      const dirPath = safePath(req.body.path);
      fs.mkdirSync(dirPath, { recursive: true });
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // Download file
  app.get('/api/files/download', requireAuth, (req, res) => {
    try {
      const filePath = safePath(req.query.path);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
      res.download(filePath);
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // Upload file
  app.post('/api/files/upload', requireAuth, upload.array('files'), (req, res) => {
    try {
      const destDir = safePath(req.body.path || '');
      if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files' });
      const results = [];
      for (const file of req.files) {
        const dest = path.join(destDir, file.originalname);
        fs.renameSync(file.path, dest);
        results.push(file.originalname);
      }
      res.json({ ok: true, files: results });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });
}

module.exports = { setupFileManagerRoutes };
