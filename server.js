const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const config = require('./config');
const { db, stmts } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Basic Auth middleware ---
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    logLogin(req.ip, req.get('user-agent'), false);
    res.set('WWW-Authenticate', 'Basic realm="VPS Dashboard"');
    return res.status(401).send('Authentication required');
  }
  const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (user === config.user && pass === config.pass) {
    logLogin(req.ip, req.get('user-agent'), true);
    return next();
  }
  logLogin(req.ip, req.get('user-agent'), false);
  res.set('WWW-Authenticate', 'Basic realm="VPS Dashboard"');
  res.status(401).send('Invalid credentials');
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

// --- Socket.IO connection ---
io.on('connection', (socket) => {
  // Send current state immediately
  if (lastMetrics.ts) socket.emit('metrics', lastMetrics);
  if (lastProcesses.length) socket.emit('processes', lastProcesses);
  if (lastServices.ssh !== undefined) socket.emit('services', { services: lastServices, disk: lastDisk });
});

// --- REST API: History ---
app.get('/api/history', (req, res) => {
  const range = req.query.range || '1h';
  const now = Math.floor(Date.now() / 1000);
  const ranges = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000 };
  const since = now - (ranges[range] || 3600);
  const rows = stmts.getHistory.all(since);
  res.json(rows);
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
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/processes/:pid/kill-force', requireAuth, (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  if (!pid) return res.status(400).json({ error: 'Invalid PID' });
  try {
    process.kill(pid, 'SIGKILL');
    res.json({ ok: true, signal: 'SIGKILL', pid });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- REST API: Services ---
app.post('/api/services/:name/restart', requireAuth, (req, res) => {
  const { execSync } = require('child_process');
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  try {
    execSync(`systemctl restart ${name}`, { timeout: 30000 });
    res.json({ ok: true, service: name });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- REST API: Alerts ---
app.get('/api/alerts', requireAuth, (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  res.json(stmts.getAlerts.all(limit));
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
startChecker(stmts, io);

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
