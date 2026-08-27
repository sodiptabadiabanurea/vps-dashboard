// Docker Monitor - CLI-based (no dockerode dependency needed)
const { execFile } = require('child_process');

function execDocker(args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

async function isDockerAvailable() {
  try {
    await execDocker(['info', '--format', '{{.ServerVersion}}']);
    return true;
  } catch { return false; }
}

async function listContainers() {
  try {
    const format = '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.State}}\t{{.Ports}}\t{{.Size}}';
    const raw = await execDocker(['ps', '-a', '--format', format, '--no-trunc']);
    if (!raw) return [];
    return raw.split('\n').map(line => {
      const [id, name, image, status, state, ports, size] = line.split('\t');
      return { id, name, image, status, state, ports, size };
    });
  } catch { return []; }
}

async function getContainerStats() {
  try {
    const format = '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}';
    const raw = await execDocker(['stats', '--no-stream', '--format', format]);
    if (!raw) return [];
    return raw.split('\n').map(line => {
      const [name, cpu, memUsage, memPerc, netIO, blockIO, pids] = line.split('\t');
      return { name, cpu, memUsage, memPerc, netIO, blockIO, pids };
    });
  } catch { return []; }
}

function validateContainerName(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) {
    throw new Error('Invalid container name');
  }
  return name;
}

async function getContainerLogs(name, lines = 100) {
  try {
    const safeName = validateContainerName(name);
    const safeLines = Math.min(Math.max(Number.parseInt(lines, 10) || 100, 1), 5000);
    return await execDocker(['logs', '--tail', String(safeLines), '--timestamps', safeName]);
  } catch (err) { return `Error: ${err.message}`; }
}

async function containerAction(name, action) {
  const allowed = ['start', 'stop', 'restart', 'pause', 'unpause'];
  if (!allowed.includes(action)) throw new Error('Invalid action');
  const safeName = validateContainerName(name);
  return execDocker([action, safeName]);
}

function setupDockerRoutes(app, requireAuth) {
  app.get('/api/docker/available', requireAuth, async (req, res) => {
    res.json({ available: await isDockerAvailable() });
  });

  app.get('/api/docker/containers', requireAuth, async (req, res) => {
    res.json(await listContainers());
  });

  app.get('/api/docker/stats', requireAuth, async (req, res) => {
    res.json(await getContainerStats());
  });

  app.get('/api/docker/logs/:name', requireAuth, async (req, res) => {
    try {
      const lines = Number.parseInt(req.query.lines, 10) || 100;
      const logs = await getContainerLogs(req.params.name, lines);
      res.json({ logs });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/docker/:name/:action', requireAuth, async (req, res) => {
    try {
      await containerAction(req.params.name, req.params.action);
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });
}

module.exports = { setupDockerRoutes, isDockerAvailable, listContainers, getContainerStats, getContainerLogs, containerAction, validateContainerName };
