// SSL Certificate Monitor - check expiry for domains
const tls = require('tls');
const dns = require('dns').promises;
const net = require('net');

function isPrivateIPv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && b >= 18 && b <= 19) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) return isPrivateIPv4(address);
  if (!net.isIPv6(address)) return true;

  const normalized = address.toLowerCase();

  // IPv4-mapped IPv6 addresses can otherwise bypass an IPv4-only check.
  // Node treats these as IPv6 addresses (e.g. ::ffff:127.0.0.1).
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (net.isIPv4(mapped)) return isPrivateIPv4(mapped);
  }

  // Loopback, unspecified, unique-local, link-local, and multicast ranges.
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('ff')
  );
}

async function resolvePublicAddress(domain) {
  const addresses = await dns.lookup(domain, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Target resolves to a private or local address');
  }
  return addresses[0].address;
}

function checkSSL(domain, port = 443) {
  return new Promise(async (resolve) => {
    if (typeof domain !== 'string' || !/^[a-zA-Z0-9.-]{1,253}$/.test(domain) || domain.includes('..')) {
      return resolve({ domain, error: 'Invalid domain' });
    }

    let address;
    try {
      address = await resolvePublicAddress(domain);
    } catch (err) {
      return resolve({ domain, error: err.message });
    }

    try {
      const socket = tls.connect({
        host: address,
        port,
        servername: domain,
        rejectUnauthorized: false,
      }, () => {
        const cert = socket.getPeerCertificate();
        socket.destroy();

        if (!cert || !cert.valid_to) return resolve({ domain, error: 'No certificate found' });

        const expiry = new Date(cert.valid_to);
        const now = new Date();
        const daysLeft = Math.floor((expiry - now) / (1000 * 60 * 60 * 24));
        resolve({
          domain,
          issuer: cert.issuer ? cert.issuer.O || cert.issuer.CN : 'Unknown',
          subject: cert.subject ? cert.subject.CN : domain,
          validFrom: cert.valid_from,
          validTo: cert.valid_to,
          daysLeft,
          serialNumber: cert.serialNumber,
          valid: daysLeft > 0,
        });
      });

      socket.on('error', (err) => resolve({ domain, error: err.message }));
      socket.setTimeout(10000, () => {
        socket.destroy();
        resolve({ domain, error: 'Connection timeout' });
      });
    } catch (err) {
      resolve({ domain, error: err.message });
    }
  });
}

function setupSSLRoutes(app, requireAuth, config) {
  const defaultDomains = ['kakibaabu.duckdns.org', 'sahamradar.com'];

  app.get('/api/ssl', requireAuth, async (req, res) => {
    const domains = req.query.domains ? String(req.query.domains).split(',').slice(0, 10) : defaultDomains;
    const results = await Promise.all(domains.map(d => checkSSL(d.trim())));
    res.json(results);
  });

  app.get('/api/ssl/:domain', requireAuth, async (req, res) => {
    const result = await checkSSL(req.params.domain);
    res.json(result);
  });
}

module.exports = { setupSSLRoutes, checkSSL, isPrivateAddress, resolvePublicAddress };
