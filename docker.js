// Docker Monitor - CLI-based (no dockerode dependency needed)
const { execFile } = require('child_process');

function execCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || 'Command failed'));
      else resolve(stdout.trim());
    });
  });
}

async function isDockerAvailable() {
  try {
    await execCmd('docker', ['info', '--format', '{{.ServerVersion}}']);
    return true;
  } catch { return false; }
}

async function listContainers() {
  try {
    const format = '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.State}}\t{{.Ports}}\t{{.Size}}';
    const raw = await execCmd('docker', ['ps', '-a', '--format', format, '--no-trunc']);
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
    const raw = await execCmd('docker', ['stats', '--no-stream', '--format', format]);
    if (!raw) return [];
    return raw.split('\n').map(line => {
      const [name, cpu, memUsage, memPerc, netIO, blockIO, pids] = line.split('\t');
      return { name, cpu, memUsage, memPerc, netIO, blockIO, pids };
    });
  } catch { return []; }
}

async function getContainerLogs(name, lines = 100) {
  try {
    const safeName = name.replace(/[^a-zA-Z0-9_.-]/g, '');
    return await execCmd('docker', ['logs', '--tail', String(lines), '--timestamps', safeName]);
  } catch (err) { return 'Failed to retrieve logs'; }
}

async function containerAction(name, action) {
  const allowed = ['start', 'stop', 'restart', 'pause', 'unpause'];
  if (!allowed.includes(action)) throw new Error('Invalid action');
  const safeName = name.replace(/[^a-zA-Z0-9_.-]/g, '');
  return execCmd('docker', [action, safeName]);
}

function setupDockerRoutes(app, requireAuth) {
  // Check docker availability
  app.get('/api/docker/available', requireAuth, async (req, res) => {
    res.json({ available: await isDockerAvailable() });
  });

  // List containers
  app.get('/api/docker/containers', requireAuth, async (req, res) => {
    try {
      const containers = await listContainers();
      res.json(containers);
    } catch (err) { res.status(500).json({ error: 'Failed to list containers' }); }
  });

  // Container stats
  app.get('/api/docker/stats', requireAuth, async (req, res) => {
    try {
      const stats = await getContainerStats();
      res.json(stats);
    } catch (err) { res.status(500).json({ error: 'Failed to get container stats' }); }
  });

  // Container logs
  app.get('/api/docker/logs/:name', requireAuth, async (req, res) => {
    try {
      const lines = Math.min(parseInt(req.query.lines, 10) || 100, 1000);
      const logs = await getContainerLogs(req.params.name, lines);
      res.json({ logs });
    } catch (err) { res.status(500).json({ error: 'Failed to get container logs' }); }
  });

  // Container action
  app.post('/api/docker/:name/:action', requireAuth, async (req, res) => {
    try {
      await containerAction(req.params.name, req.params.action);
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: 'Action failed' }); }
  });
}

module.exports = { setupDockerRoutes, isDockerAvailable, listContainers, getContainerStats };
