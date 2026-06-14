// 2FA (TOTP) - Two-Factor Authentication
const crypto = require('crypto');

// Simple TOTP implementation (no external dependency)
function generateSecret() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let secret = '';
  const bytes = crypto.randomBytes(20);
  for (let i = 0; i < 20; i++) {
    secret += chars[bytes[i] % 32];
  }
  return secret;
}

function generateTOTP(secret, timeStep = 30) {
  const time = Math.floor(Date.now() / 1000 / timeStep);
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeBigInt64BE(BigInt(time));

  // Decode base32 secret
  const key = base32Decode(secret);

  // HMAC-SHA1
  const hmac = crypto.createHmac('sha1', key);
  hmac.update(timeBuffer);
  const hash = hmac.digest();

  // Dynamic truncation
  const offset = hash[hash.length - 1] & 0x0f;
  const code = ((hash[offset] & 0x7f) << 24) |
               ((hash[offset + 1] & 0xff) << 16) |
               ((hash[offset + 2] & 0xff) << 8) |
               (hash[offset + 3] & 0xff);

  return String(code % 1000000).padStart(6, '0');
}

function verifyTOTP(secret, token, window = 1) {
  const timeStep = 30;
  for (let i = -window; i <= window; i++) {
    const time = Math.floor(Date.now() / 1000 / timeStep) + i;
    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeBigInt64BE(BigInt(time));
    const key = base32Decode(secret);
    const hmac = crypto.createHmac('sha1', key);
    hmac.update(timeBuffer);
    const hash = hmac.digest();
    const offset = hash[hash.length - 1] & 0x0f;
    const code = ((hash[offset] & 0x7f) << 24) |
                 ((hash[offset + 1] & 0xff) << 16) |
                 ((hash[offset + 2] & 0xff) << 8) |
                 (hash[offset + 3] & 0xff);
    const expected = String(code % 1000000).padStart(6, '0');
    if (expected === token) return true;
  }
  return false;
}

function base32Decode(str) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of str.toUpperCase()) {
    const val = chars.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateQRUrl(secret, user = 'admin', issuer = 'VPS Dashboard') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(user)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}

function setupTwoFARoutes(app, requireAuth, stmts, auditLog) {
  // Enable 2FA - generate secret
  app.post('/api/2fa/enable', requireAuth, (req, res) => {
    const secret = generateSecret();
    const qrUrl = generateQRUrl(secret);
    stmts.setTwoFASecret.run(secret);
    auditLog('2fa_enable', '2FA secret generated');
    res.json({ secret, qrUrl });
  });

  // Verify and activate 2FA
  app.post('/api/2fa/verify', requireAuth, (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const row = stmts.getTwoFAConfig.get();
    if (!row || !row.secret) return res.status(400).json({ error: '2FA not initialized' });

    if (verifyTOTP(row.secret, token)) {
      stmts.enableTwoFA.run();
      auditLog('2fa_activate', '2FA activated');
      res.json({ ok: true, verified: true });
    } else {
      res.json({ ok: false, verified: false, error: 'Invalid token' });
    }
  });

  // Disable 2FA
  app.post('/api/2fa/disable', requireAuth, (req, res) => {
    stmts.disableTwoFA.run();
    auditLog('2fa_disable', '2FA disabled');
    res.json({ ok: true });
  });

  // Get 2FA status
  app.get('/api/2fa/status', requireAuth, (req, res) => {
    const row = stmts.getTwoFAConfig.get();
    res.json({
      enabled: row ? row.enabled === 1 : false,
      hasSecret: row ? !!row.secret : false,
    });
  });
}

module.exports = { generateSecret, generateTOTP, verifyTOTP, setupTwoFARoutes };
