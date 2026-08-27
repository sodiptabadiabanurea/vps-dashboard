// File Manager - browse, upload, download, edit, delete files
const fs = require('fs');
const path = require('path');
const os = require('os');
const multer = require('multer');

const ROOT = path.resolve(process.env.FM_ROOT || os.homedir());

function isWithinRoot(candidate) {
  const relative = path.relative(ROOT, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safePath(requestedPath) {
  const value = typeof requestedPath === 'string' ? requestedPath : '';
  const lexical = path.resolve(ROOT, value);
  if (!isWithinRoot(lexical)) throw new Error('Access denied');

  try {
    const canonical = fs.realpathSync(lexical);
    if (!isWithinRoot(canonical)) throw new Error('Access denied');
    return canonical;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // For new files, canonicalize and validate the nearest existing parent.
    let parent = path.dirname(lexical);
    while (!fs.existsSync(parent)) {
      const next = path.dirname(parent);
      if (next === parent) throw new Error('Access denied');
      parent = next;
    }
    const canonicalParent = fs.realpathSync(parent);
    if (!isWithinRoot(canonicalParent)) throw new Error('Access denied');
    return path.join(canonicalParent, path.basename(lexical));
  }
}

function safeUploadName(name) {
  const base = path.basename(typeof name === 'string' ? name : '');
  if (!base || base === '.' || base === '..' || base.includes('\0')) throw new Error('Invalid filename');
  return base;
}

function setupFileManagerRoutes(app, requireAuth) {
  const upload = multer({
    dest: '/tmp/vps-dashboard-uploads/',
    limits: { files: 20, fileSize: 50 * 1024 * 1024 },
  });

  app.get('/api/files', requireAuth, (req, res) => {
    try {
      const dirPath = safePath(req.query.path || '');
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const items = entries.map(entry => {
        const fullPath = safePath(path.relative(ROOT, path.join(dirPath, entry.name)));
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
      items.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      res.json({ path: path.relative(ROOT, dirPath), items });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.get('/api/files/read', requireAuth, (req, res) => {
    try {
      const filePath = safePath(req.query.path);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) return res.status(400).json({ error: 'Not a regular file' });
      if (stats.size > 5 * 1024 * 1024) return res.status(400).json({ error: 'File too large (>5MB)' });
      const content = fs.readFileSync(filePath, 'utf8');
      res.json({ content, size: stats.size, path: path.relative(ROOT, filePath) });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/files/write', requireAuth, (req, res) => {
    try {
      const filePath = safePath(req.body.path);
      if (fs.existsSync(filePath) && !fs.statSync(filePath).isFile()) return res.status(400).json({ error: 'Not a regular file' });
      fs.writeFileSync(filePath, typeof req.body.content === 'string' ? req.body.content : '', 'utf8');
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/files/delete', requireAuth, (req, res) => {
    try {
      const filePath = safePath(req.body.path);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
      const stats = fs.lstatSync(filePath);
      if (stats.isSymbolicLink()) return res.status(400).json({ error: 'Symlinks cannot be deleted through the file manager' });
      if (stats.isDirectory()) fs.rmSync(filePath, { recursive: true, force: true });
      else fs.unlinkSync(filePath);
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/files/mkdir', requireAuth, (req, res) => {
    try {
      const dirPath = safePath(req.body.path);
      fs.mkdirSync(dirPath, { recursive: true });
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.get('/api/files/download', requireAuth, (req, res) => {
    try {
      const filePath = safePath(req.query.path);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
      if (!fs.statSync(filePath).isFile()) return res.status(400).json({ error: 'Not a regular file' });
      res.download(filePath);
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/files/upload', requireAuth, upload.array('files'), (req, res) => {
    try {
      const destDir = safePath(req.body.path || '');
      if (!fs.statSync(destDir).isDirectory()) return res.status(400).json({ error: 'Destination is not a directory' });
      if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files' });
      const results = [];
      for (const file of req.files) {
        const filename = safeUploadName(file.originalname);
        const dest = safePath(path.relative(ROOT, path.join(destDir, filename)));
        fs.renameSync(file.path, dest);
        results.push(filename);
      }
      res.json({ ok: true, files: results });
    } catch (err) {
      for (const file of req.files || []) {
        try { fs.unlinkSync(file.path); } catch {}
      }
      res.status(400).json({ error: err.message });
    }
  });
}

module.exports = { setupFileManagerRoutes, safePath, safeUploadName, isWithinRoot };
