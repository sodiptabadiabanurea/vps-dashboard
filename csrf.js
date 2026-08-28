const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function getAllowedOrigins(req) {
  const configured = (process.env.CSRF_ALLOWED_ORIGINS || '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);

  if (configured.length) return new Set(configured);

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || 'http';
  const host = req.get('host');
  const expected = normalizeOrigin(`${protocol}://${host}`);
  return expected ? new Set([expected]) : new Set();
}

function isTrustedOrigin(req, value) {
  const origin = normalizeOrigin(value);
  if (!origin) return false;
  return getAllowedOrigins(req).has(origin);
}

function csrfProtection(req, res, next) {
  if (!STATE_CHANGING_METHODS.has(req.method)) return next();

  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite && !new Set(['same-origin', 'same-site', 'none']).has(fetchSite.toLowerCase())) {
    return res.status(403).json({ error: 'Cross-site request blocked' });
  }

  const origin = req.get('origin');
  if (origin) {
    if (!isTrustedOrigin(req, origin)) {
      return res.status(403).json({ error: 'Invalid origin' });
    }
    return next();
  }

  const referer = req.get('referer');
  if (referer) {
    if (!isTrustedOrigin(req, referer)) {
      return res.status(403).json({ error: 'Invalid referer' });
    }
    return next();
  }

  // Non-browser clients may not send Origin/Referer/Fetch Metadata.
  return next();
}

module.exports = { csrfProtection, isTrustedOrigin, normalizeOrigin, STATE_CHANGING_METHODS };
