// Network Tools - ping, traceroute, DNS lookup, basic port scan
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

function runCmd(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      resolve(output || (err ? err.message : ''));
    });
  });
}

function findExecutable(candidates) {
  const dirs = (process.env.PATH || DEFAULT_PATH).split(':').filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes('/')) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch (_) {}
      continue;
    }

    for (const dir of dirs) {
      const fullPath = path.join(dir, candidate);
      try {
        fs.accessSync(fullPath, fs.constants.X_OK);
        return fullPath;
      } catch (_) {}
    }
  }

  return null;
}

function sanitize(input) {
  return String(input || '').replace(/[^a-zA-Z0-9._:-]/g, '');
}

function sanitizeRecordType(input) {
  const type = sanitize(input || 'A').toUpperCase();
  const allowed = new Set(['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'SOA', 'CAA']);
  return allowed.has(type) ? type : 'A';
}

function checkPort(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (status) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ port, status });
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => finish('open'));
    socket.once('timeout', () => finish('filtered'));
    socket.once('error', () => finish('closed'));
    socket.connect(port, host);
  });
}

function setupNetworkToolRoutes(app, requireAuth) {
  // Ping
  app.get('/api/tools/ping', requireAuth, async (req, res) => {
    const host = sanitize(req.query.host);
    if (!host) return res.status(400).json({ error: 'Host required' });
    const count = String(Math.min(parseInt(req.query.count, 10) || 4, 10));
    const output = await runCmd('ping', ['-c', count, '-W', '3', host]);
    res.json({ host, output });
  });

  // Traceroute. Prefer traceroute when installed; fall back to tracepath on lean VPS images.
  app.get('/api/tools/traceroute', requireAuth, async (req, res) => {
    const host = sanitize(req.query.host);
    if (!host) return res.status(400).json({ error: 'Host required' });

    const tracer = findExecutable(['traceroute', 'tracepath']);
    if (!tracer) {
      return res.status(500).json({ host, output: 'No traceroute-compatible command found (traceroute/tracepath missing).' });
    }

    const tool = path.basename(tracer);
    const args = tool === 'traceroute'
      ? ['-m', '20', '-w', '3', host]
      : ['-m', '20', host];
    const output = await runCmd(tracer, args, 60000);
    res.json({ host, tool, output });
  });

  // DNS lookup
  app.get('/api/tools/dns', requireAuth, async (req, res) => {
    const host = sanitize(req.query.host);
    if (!host) return res.status(400).json({ error: 'Host required' });
    const type = sanitizeRecordType(req.query.type);
    const output = await runCmd('dig', ['+short', host, type]);
    res.json({ host, type, result: output ? output.split('\n').filter(Boolean) : [] });
  });

  // Whois
  app.get('/api/tools/whois', requireAuth, async (req, res) => {
    const domain = sanitize(req.query.domain);
    if (!domain) return res.status(400).json({ error: 'Domain required' });
    const whois = findExecutable(['whois']);
    if (!whois) return res.status(500).json({ domain, output: 'whois command not installed.' });
    const output = await runCmd(whois, [domain], 15000);
    res.json({ domain, output });
  });

  // Port scan (basic common ports)
  app.get('/api/tools/portscan', requireAuth, async (req, res) => {
    const host = sanitize(req.query.host);
    if (!host) return res.status(400).json({ error: 'Host required' });
    const ports = [22, 80, 443, 3000, 3306, 5432, 8080, 8443];
    const results = await Promise.all(ports.map(port => checkPort(host, port)));
    res.json({ host, ports: results });
  });
}

module.exports = { setupNetworkToolRoutes };
