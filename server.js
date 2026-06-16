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

// The dashboard is served behind local Nginx. Trust only loopback proxy headers
// so rate limiting sees the real client IP instead of 127.0.0.1 for everyone.
app.set('trust proxy', 'loopback');

// --- Security headers ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
      // The current dashboard still uses inline onclick/onchange handlers in several
      // feature pages. Helmet's default CSP3 `script-src-attr 'none'` blocks those
      // handlers even when `script-src` includes `unsafe-inline`, which made Tools
      // buttons look clickable but do nothing. Keep this explicit until the UI is
      // migrated to addEventListener-only handlers.
      scriptSrcAttr: ["'unsafe-inline'"],
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
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => (
    req.path === '/' ||
    req.path.startsWith('/socket.io/') ||
    req.path.startsWith('/js/') ||
    req.path.startsWith('/css/') ||
    req.path.startsWith('/assets/') ||
    req.path.endsWith('.js') ||
    req.path.endsWith('.css') ||
    req.path.endsWith('.svg') ||
    req.path.endsWith('.png')
  ),
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
      (() => { const root = (lastDisk.filesystems || []).find(f => f.mount === '/'); return root ? root.used : 0; })(),
      (() => { const root = (lastDisk.filesystems || []).find(f => f.mount === '/'); return root ? root.size : 0; })(),
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
});

app.get('/api/alerts/suppression', requireAuth, (_req, res) => {
  res.json(alertEngine.getSuppressionStats());
});

// --- Alert engine callback ---
alertEngine.init(stmts, io);
initTimeline(stmts, io);

// --- REST API: Predictive Forecasting ---
app.get('/api/forecast', requireAuth, (_req, res) => {
  try {
    const now = Math.floor(Date.now() / 1000);
    const since = now - 30 * 86400; // 30 days of data
    const rows = stmts.getMetricsRange.all(since);

    if (rows.length < 100) {
      return res.json({ error: 'Need at least 100 data points for forecast', ready: false });
    }

    // Simple linear regression: y = mx + b
    function regression(data, xFn, yFn) {
      const n = data.length;
      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
      for (const d of data) {
        const x = xFn(d), y = yFn(d);
        sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x;
      }
      const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
      const intercept = (sumY - slope * sumX) / n;
      // R-squared
      const yMean = sumY / n;
      let ssRes = 0, ssTot = 0;
      for (const d of data) {
        const x = xFn(d), y = yFn(d);
        const predicted = slope * x + intercept;
        ssRes += (y - predicted) ** 2;
        ssTot += (y - yMean) ** 2;
      }
      const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
      return { slope, intercept, r2 };
    }

    // Index-based regression (data point index as x)
    const ts0 = rows[0].ts;
    const xFn = d => (d.ts - ts0) / 86400; // days since first sample

    // Disk (used_bytes / total)
    const diskReg = regression(rows, xFn, d => d.disk_used);
    const diskPct = rows[rows.length - 1].disk_total > 0 ? (rows[rows.length - 1].disk_used / rows[rows.length - 1].disk_total) * 100 : 0;
    // Meaningful growth: at least 1 MB/day for disk, 512 KB/day for RAM
    const MIN_DISK_GROWTH = 1024 * 1024; // 1 MB/day
    const MIN_RAM_GROWTH = 512 * 1024;   // 512 KB/day

    let diskFullDays = null;
    if (diskReg.slope * 86400 > MIN_DISK_GROWTH && rows[rows.length - 1].disk_total > 0) {
      const daysToFull = (rows[rows.length - 1].disk_total - rows[rows.length - 1].disk_used) / (diskReg.slope * 86400);
      if (daysToFull > 0 && daysToFull < 3650) diskFullDays = Math.round(daysToFull);
    }

    // RAM
    const ramReg = regression(rows, xFn, d => d.ram_used);
    let ramExhaustionDays = null;
    if (ramReg.slope * 86400 > MIN_RAM_GROWTH && rows[rows.length - 1].ram_total > 0) {
      const daysToFull = (rows[rows.length - 1].ram_total - rows[rows.length - 1].ram_used) / (ramReg.slope * 86400);
      if (daysToFull > 0 && daysToFull < 3650) ramExhaustionDays = Math.round(daysToFull);
    }

    // CPU trend
    const cpuReg = regression(rows, xFn, d => d.cpu);
    const cpuTrend = cpuReg.slope * 86400 >= 0.5 ? 'rising' : cpuReg.slope * 86400 <= -0.5 ? 'falling' : 'stable';

    // Current values
    const latest = rows[rows.length - 1];
    const diskFreeGB = ((latest.disk_total - latest.disk_used) / (1024 * 1024 * 1024)).toFixed(1);
    const ramUsedPct = latest.ram_total > 0 ? Math.round((latest.ram_used / latest.ram_total) * 100) : 0;

    res.json({
      ready: true,
      data_points: rows.length,
      period_days: Math.round((rows[rows.length - 1].ts - rows[0].ts) / 86400),
      disk: {
        used_pct: Math.round(diskPct),
        free_gb: parseFloat(diskFreeGB),
        trend: diskReg.slope * 86400 > MIN_DISK_GROWTH ? 'growing' : diskReg.slope * 86400 < -MIN_DISK_GROWTH ? 'shrinking' : 'stable',
        days_to_full: diskFullDays,
        r2: Math.round(diskReg.r2 * 100),
      },
      ram: {
        used_pct: ramUsedPct,
        trend: ramReg.slope * 86400 > MIN_RAM_GROWTH ? 'growing' : 'stable',
        days_to_exhaustion: ramExhaustionDays,
        r2: Math.round(ramReg.r2 * 100),
      },
      cpu: {
        trend: cpuTrend,
        avg_30d: Math.round(rows.reduce((s, r) => s + r.cpu, 0) / rows.length),
        r2: Math.round(cpuReg.r2 * 100),
      },
    });
  } catch (e) {
    res.json({ error: 'Forecast unavailable', ready: false });
  }
});

// --- Hook alert events into timeline ---
const origAlertInsert = stmts.insertAlert;
stmts.insertAlert = new Proxy(origAlertInsert, {
  get(target, prop, receiver) {
    if (prop === 'run') {
      return (...args) => {
        const result = target.run(...args);
        const [ts, type, message, value, threshold] = args;
        record(`alert_${type}`, 'alert', `${type.toUpperCase()} at ${value}%`, message, 'alert-engine', { value, threshold });
        return result;
      };
    }

    const value = Reflect.get(target, prop, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  }
});
initAuditTables(db);
initAudit(stmts);

// Hook suppressed alerts into timeline
io.on('connection', (socket) => {
  socket.on('alert-suppressed', (data) => {
    record(`suppressed_${data.type}`, 'alert', `${data.type.toUpperCase()} alert suppressed`, `${data.reason} — ${data.value}% (threshold: ${data.threshold}%)`, 'alert-engine', data);
  });
});

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
