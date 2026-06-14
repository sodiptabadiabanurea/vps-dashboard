// SSL Certificate Monitor - check expiry for domains
const tls = require('tls');
const https = require('https');

function checkSSL(domain, port = 443) {
  return new Promise((resolve) => {
    try {
      const socket = tls.connect({ host: domain, port, servername: domain, rejectUnauthorized: false }, () => {
        const cert = socket.getPeerCertificate();
        socket.destroy();

        if (!cert || !cert.valid_to) {
          return resolve({ domain, error: 'No certificate found' });
        }

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

      socket.on('error', (err) => {
        resolve({ domain, error: err.message });
      });

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

  // Check all domains
  app.get('/api/ssl', requireAuth, async (req, res) => {
    const domains = req.query.domains ? req.query.domains.split(',') : defaultDomains;
    const results = await Promise.all(domains.map(d => checkSSL(d.trim())));
    res.json(results);
  });

  // Check single domain
  app.get('/api/ssl/:domain', requireAuth, async (req, res) => {
    const result = await checkSSL(req.params.domain);
    res.json(result);
  });
}

module.exports = { setupSSLRoutes, checkSSL };
