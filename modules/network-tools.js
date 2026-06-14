// Network Tools - ping, traceroute, DNS lookup
const { execFile } = require('child_process');

function runCmd(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve(err ? stderr || err.message : stdout);
    });
  });
}

function sanitize(input) {
  return input.replace(/[^a-zA-Z0-9._:-]/g, '');
}

function setupNetworkToolRoutes(app, requireAuth) {
  // Ping
  app.get('/api/tools/ping', requireAuth, async (req, res) => {
    const host = sanitize(req.query.host || '');
    if (!host) return res.status(400).json({ error: 'Host required' });
    const count = String(Math.min(parseInt(req.query.count, 10) || 4, 10));
    const output = await runCmd('ping', ['-c', count, '-W', '3', host]);
    res.json({ host, output });
  });

  // Traceroute
  app.get('/api/tools/traceroute', requireAuth, async (req, res) => {
    const host = sanitize(req.query.host || '');
    if (!host) return res.status(400).json({ error: 'Host required' });
    const output = await runCmd('traceroute', ['-m', '20', '-w', '3', host], 60000);
    res.json({ host, output });
  });

  // DNS lookup
  app.get('/api/tools/dns', requireAuth, async (req, res) => {
    const host = sanitize(req.query.host || '');
    if (!host) return res.status(400).json({ error: 'Host required' });
    const type = sanitize(req.query.type || 'A');
    const output = await runCmd('dig', ['+short', host, type]);
    res.json({ host, type, result: output.trim().split('\n') });
  });

  // Whois
  app.get('/api/tools/whois', requireAuth, async (req, res) => {
    const domain = sanitize(req.query.domain || '');
    if (!domain) return res.status(400).json({ error: 'Domain required' });
    const output = await runCmd('whois', [domain], 15000);
    res.json({ domain, output });
  });

  // Port scan (basic)
  app.get('/api/tools/portscan', requireAuth, async (req, res) => {
    const host = sanitize(req.query.host || '');
    if (!host) return res.status(400).json({ error: 'Host required' });
    const ports = [22, 80, 443, 3000, 3306, 5432, 8080, 8443];
    const results = [];

    for (const port of ports) {
      const output = await runCmd('timeout', ['2', 'bash', '-c', `echo > /dev/tcp/${host}/${port}`], 5000);
      results.push({ port, status: output.trim().includes('open') ? 'open' : 'closed' });
    }

    res.json({ host, ports: results });
  });
}

module.exports = { setupNetworkToolRoutes };
