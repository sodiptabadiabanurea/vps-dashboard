const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { db, stmts } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Security headers ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "ws:", "wss:"],
    },
  },
}));

// --- Rate limiting ---
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});
app.use(globalLimiter);

// Stricter limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts, please try again later' },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Error sanitization ---
function sanitizeError(err) {
  const msg = err.message || 'Internal error';
  // Strip file paths, stack traces, and internal details
  return msg
    .replace(/\/[^\s:]+/g, '[path]')         // file paths
    .replace(/at\s+.*\(.*\)/g, '')            // stack trace lines
    .replace(/Error:\s*/i, '');               // redundant prefix
}

// --- 2FA check helper ---
const { verifyTOTP } = require('./modules/twofa');

function isTwoFAEnabled() {
  try {
    const row = stmts.getTwoFAConfig.get();
    return row && row.enabled === 1 && row.secret;
  } catch {
    return false;
  }
}

// --- Basic Auth middleware ---
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    logLogin(req.ip, req.get('user-agent'), false);
    res.set('WWW-Authenticate', 'Basic realm="VPS Dashboard"');
    return res.status(401).json({ error: 'Authentication required' });
  }
  const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (user === config.user && pass === config.pass) {
    // Check 2FA if enabled (skip for 2FA management routes)
    if (isTwoFAEnabled() && !req.path.startsWith('/api/2fa/')) {
      const totpToken = req.headers['x-2fa-token'];
      if (!totpToken) {
        return res.status(403).json({ error: '2FA token required', code: '2FA_REQUIRED' });
      }
      const row = stmts.getTwoFAConfig.get();
      if (!verifyTOTP(row.secret, totpToken)) {
        logLogin(req.ip, req.get('user-agent'), false);
        return res.status(403).json({ error: 'Invalid 2FA token' });
      }
    }
    logLogin(req.ip, req.get('user-agent'), true);
    return next();
  }
  logLogin(req.ip, req.get('user-agent'), false);
  res.set('WWW-Authenticate', 'Basic realm="VPS Dashboard"');
  res.status(401).json({ error: 'Invalid credentials' });
}

// --- Collectors ---
const cpuCollector = require('./collectors/cpu');
const memoryCollector = require('./collectors/memory');
const diskCollector = require('./collectors/disk');
const networkCollector = require('./collectors/network');
const processesCollector = require('./collectors/processes');
const servicesCollector = require('./collectors/services');

// --- Alert engine ---
const alertEngine = require('./alerts/engine');

// --- New features ---
const { setupTerminal } = require('./terminal');
const { setupDockerRoutes } = require('./docker');
const { setupFileManagerRoutes } = require('./filemanager');
const { initUptimeTables, startChecker, setupUptimeRoutes } = require('./uptime');
const { initTimeline, record, setupTimelineRoutes, ICONS } = require('./modules/timeline');

// --- Additional modules ---
const { setupLogRoutes } = require('./modules/logs');
const { setupCronRoutes } = require('./modules/cron');
const { setupSSLRoutes } = require('./modules/ssl');
const { setupNetworkToolRoutes } = require('./modules/network-tools');
const { setupBackupRoutes } = require('./modules/backup');
const { setupFail2banRoutes } = require('./modules/fail2ban');
const { initAuditTables, initAudit, logLogin, auditLog, setupAuditRoutes } = require('./modules/audit');
const { setupTwoFARoutes } = require('./modules/twofa');
const { setupNotificationRoutes } = require('./modules/notifications');
const { setupHealthRoutes } = require('./modules/health');

// --- State ---
let lastMetrics = {};
let lastProcesses = [];
let lastServices = {};
let lastDisk = {};

// --- Metrics collection loop ---
async function collectMetrics() {
  try {
    const [cpu, mem, net] = await Promise.all([
      cpuCollector(),
      memoryCollector(),
      networkCollector(config.networkInterface),
    ]);

    const metrics = {
      ts: Date.now(),
      cpu: cpu.usage,
      ram_used: mem.ram.used,
      ram_total: mem.ram.total,
      ram_percent: mem.ram.percent,
      swap_used: mem.swap.used,
      swap_total: mem.swap.total,
      swap_percent: mem.swap.percent,
      net_rx: net.rx_bytes,
      net_tx: net.tx_bytes,
      net_rx_speed: net.rx_speed,
      net_tx_speed: net.tx_speed,
      net_tcp: net.tcp_connections,
    };

    lastMetrics = metrics;
    app.locals.lastMetrics = metrics;
    io.emit('metrics', metrics);

    // Check alerts
    alertEngine.check(metrics);
  } catch (err) {
    console.error('Metrics collection error:', err.message);
  }
}

// --- Processes collection loop ---
async function collectProcesses() {
  try {
    lastProcesses = await processesCollector();
    app.locals.lastProcesses = lastProcesses;
    io.emit('processes', lastProcesses);
  } catch (err) {
    console.error('Processes collection error:', err.message);
  }
}

// --- Services collection loop ---
async function collectServices() {
  try {
    const services = await servicesCollector(config.services);
    const disk = await diskCollector();
    lastServices = services;
    lastDisk = disk;
    app.locals.lastServices = services;
    app.locals.lastDisk = disk;
    io.emit('services', { services, disk, uptime: process.uptime() });
  } catch (err) {
    console.error('Services collection error:', err.message);
  }
}

// --- History write loop ---
function writeHistory() {
  if (!lastMetrics.ts) return;
  try {
    stmts.insertMetric.run(
      Math.floor(lastMetrics.ts / 1000),
      lastMetrics.cpu,
      lastMetrics.ram_used,
      lastMetrics.ram_total,
      lastMetrics.swap_used,
      lastMetrics.swap_total,
      lastMetrics.disk_used || 0,
      lastMetrics.disk_total || 0,
      lastMetrics.net_rx,
      lastMetrics.net_tx
    );
  } catch (err) {
    console.error('History write error:', err.message);
  }
}

// --- Socket.IO connection (main namespace — requires auth) ---
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));

  try {
    const decoded = Buffer.from(token, 'base64').toString();
    const [user, pass] = decoded.split(':');
    if (user === config.user && pass === config.pass) return next();
  } catch (_) {}

  next(new Error('Invalid credentials'));
});

io.on('connection', (socket) => {
  // Send current state immediately
  if (lastMetrics.ts) socket.emit('metrics', lastMetrics);
  if (lastProcesses.length) socket.emit('processes', lastProcesses);
  if (lastServices.ssh !== undefined) socket.emit('services', { services: lastServices, disk: lastDisk });
});

// --- REST API: History (now requires auth) ---
app.get('/api/history', requireAuth, (req, res) => {
  const range = req.query.range || '1h';
  const now = Math.floor(Date.now() / 1000);
  const ranges = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000 };
  const since = now - (ranges[range] || 3600);
  const rows = stmts.getHistory.all(since);
  res.json(rows);
});

// --- REST API: Session token for Socket.IO auth ---
app.get('/api/session', requireAuth, (req, res) => {
  const auth = req.headers.authorization;
  const token = auth.split(' ')[1]; // already base64
  res.json({ token });
});

// --- REST API: Processes ---
app.get('/api/processes', requireAuth, (req, res) => {
  res.json(lastProcesses);
});

app.post('/api/processes/:pid/kill', requireAuth, (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  if (!pid) return res.status(400).json({ error: 'Invalid PID' });
  try {
    process.kill(pid, 'SIGTERM');
    res.json({ ok: true, signal: 'SIGTERM', pid });
  } catch (err) {
    res.status(400).json({ error: sanitizeError(err) });
  }
});

app.post('/api/processes/:pid/kill-force', requireAuth, (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  if (!pid) return res.status(400).json({ error: 'Invalid PID' });
  try {
    process.kill(pid, 'SIGKILL');
    res.json({ ok: true, signal: 'SIGKILL', pid });
  } catch (err) {
    res.status(400).json({ error: sanitizeError(err) });
  }
});

// --- REST API: Services ---
app.post('/api/services/:name/restart', requireAuth, (req, res) => {
  const { execFile } = require('child_process');
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  execFile('systemctl', ['restart', name], { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) return res.status(400).json({ error: 'Service restart failed' });
    res.json({ ok: true, service: name });
  });
});

// --- REST API: Alerts ---
app.get('/api/alerts', requireAuth, (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  res.json(stmts.getAlerts.all(limit));
});

app.get('/api/alerts/history', requireAuth, (req, res) => {
  const range = req.query.range || '24h';
  const now = Math.floor(Date.now() / 1000);
  const ranges = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800 };
  const since = now - (ranges[range] || 86400);
  res.json(stmts.getAlertsSince.all(since));
});

app.get('/api/alerts/config', requireAuth, (req, res) => {
  res.json(stmts.getAlertConfig.all());
});

app.put('/api/alerts/config/:type', requireAuth, (req, res) => {
  const { type } = req.params;
  const { enabled, threshold, cooldown } = req.body;
  stmts.updateAlertConfig.run(enabled ? 1 : 0, threshold, cooldown, type);
  alertEngine.reloadConfig();
  res.json({ ok: true });
});

// --- Alert engine callback ---
alertEngine.init(stmts, io);
initTimeline(stmts, io);

// --- Hook alert events into timeline ---
const origAlertInsert = stmts.insertAlert;
stmts.insertAlert = new Proxy(origAlertInsert, {
  apply(target, thisArg, args) {
    const result = target.apply(thisArg, args);
    const [ts, type, message, value, threshold] = args;
    record(`alert_${type}`, 'alert', `${type.toUpperCase()} at ${value}%`, message, 'alert-engine', { value, threshold });
    return result;
  }
});
initAuditTables(db);
initAudit(stmts);

// --- Terminal ---
setupTerminal(io);

// --- Docker ---
setupDockerRoutes(app, requireAuth);

// --- File Manager ---
setupFileManagerRoutes(app, requireAuth);

// --- Uptime Monitor ---
setupUptimeRoutes(app, requireAuth, stmts);

// --- Incident Timeline ---
setupTimelineRoutes(app, requireAuth);
startChecker(stmts, io);

// Hook uptime failures into timeline
io.on('connection', (socket) => {
  socket.on('uptime-check', (data) => {
    if (data.status === 0 || data.status >= 500) {
      record('uptime_down', 'uptime', `Target ${data.target_id} DOWN`, `HTTP ${data.status}: ${data.error || 'unreachable'}`, 'uptime-checker', { target_id: data.target_id, status: data.status });
    }
  });
});

// --- Additional modules ---
setupLogRoutes(app, requireAuth);
setupCronRoutes(app, requireAuth, auditLog);
setupSSLRoutes(app, requireAuth, config);
setupNetworkToolRoutes(app, requireAuth);
setupBackupRoutes(app, requireAuth, auditLog, config);
setupFail2banRoutes(app, requireAuth, auditLog);
setupAuditRoutes(app, requireAuth);
setupTwoFARoutes(app, requireAuth, stmts, auditLog);
setupNotificationRoutes(app, requireAuth, stmts, auditLog);
setupHealthRoutes(app, requireAuth, stmts);

// --- Start collection loops ---
setInterval(collectMetrics, config.metricsInterval);
setInterval(collectProcesses, config.processesInterval);
setInterval(collectServices, config.servicesInterval);
setInterval(writeHistory, config.historyWriteInterval);

collectMetrics();
collectProcesses();
collectServices();

// --- Start server ---
server.listen(config.port, config.hostname, () => {
  console.log(`VPS Dashboard running at http://${config.hostname}:${config.port}`);
});
