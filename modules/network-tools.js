// Network Tools - ping, traceroute, DNS lookup
const { execFile } = require('child_process');

function runCmd(command, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve(err ? stderr || err.message : stdout);
    });
  });
}

function sanitizeHost(input) {
  const value = String(input || '').trim();
  if (!value || value.length > 253 || !/^[a-zA-Z0-9._:-]+$/.test(value)) return '';
  return value;
}

const ALLOWED_DNS_TYPES = new Set(['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'SRV', 'CAA', 'PTR']);

function setupNetworkToolRoutes(app, requireAuth) {
  app.get('/api/tools/ping', requireAuth, async (req, res) => {
    const host = sanitizeHost(req.query.host);
    if (!host) return res.status(400).json({ error: 'Invalid host' });
    const count = Math.min(Math.max(parseInt(req.query.count, 10) || 4, 1), 10);
    const output = await runCmd('ping', ['-c', String(count), '-W', '3', host]);
    res.json({ host, output });
  });

  app.get('/api/tools/traceroute', requireAuth, async (req, res) => {
    const host = sanitizeHost(req.query.host);
    if (!host) return res.status(400).json({ error: 'Invalid host' });
    const output = await runCmd('traceroute', ['-m', '20', '-w', '3', host], 60000);
    res.json({ host, output });
  });

  app.get('/api/tools/dns', requireAuth, async (req, res) => {
    const host = sanitizeHost(req.query.host);
    if (!host) return res.status(400).json({ error: 'Invalid host' });
    const type = String(req.query.type || 'A').toUpperCase();
    if (!ALLOWED_DNS_TYPES.has(type)) return res.status(400).json({ error: 'Invalid DNS record type' });
    const output = await runCmd('dig', ['+short', host, type]);
    res.json({ host, type, result: output.trim().split('\n').filter(Boolean) });
  });

  app.get('/api/tools/whois', requireAuth, async (req, res) => {
    const domain = sanitizeHost(req.query.domain);
    if (!domain) return res.status(400).json({ error: 'Invalid domain' });
    const output = await runCmd('whois', [domain], 15000);
    res.json({ domain, output });
  });

  app.get('/api/tools/portscan', requireAuth, async (req, res) => {
    const host = sanitizeHost(req.query.host);
    if (!host) return res.status(400).json({ error: 'Invalid host' });
    const ports = [22, 80, 443, 3000, 3306, 5432, 8080, 8443];
    const results = [];
    for (const port of ports) {
      const output = await runCmd('nc', ['-z', '-w', '2', host, String(port)], 3000);
      results.push({ port, status: output.trim() === '' ? 'open' : 'closed' });
    }
    res.json({ host, ports: results });
  });
}

module.exports = { setupNetworkToolRoutes, sanitizeHost, ALLOWED_DNS_TYPES };
