// Network Tools - ping, traceroute, DNS lookup, basic port scan
const fs = require('fs');
const path = require('path');
const {
  runDnsDiagnostic,
  runNetworkDiagnosis,
  runPingDiagnostic,
  runPortScanDiagnostic,
  runTraceDiagnostic,
} = require('./network-diagnostics');
const {
  ToolInputError,
  commandOutput,
  createOperationLimiter,
  createRequestId,
  normalizeTarget,
  runCommand,
} = require('./network-tools-core');

const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

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

function sendRouteError(res, error, requestId, tool) {
  const status = Number(error.statusCode) || 500;
  return res.status(status).json({
    schema_version: 2,
    request_id: requestId,
    tool,
    ok: false,
    status: 'error',
    error: status >= 500 ? 'Network diagnostic failed.' : error.message,
    diagnosis: {
      code: error.code || 'TOOL_ERROR',
      severity: 'error',
      summary: status >= 500 ? 'Network diagnostic failed.' : error.message,
    },
  });
}

const operationLimiter = createOperationLimiter({
  globalLimit: 4,
  perToolLimit: {
    ping: 2,
    traceroute: 1,
    dns: 3,
    whois: 1,
    portscan: 2,
    diagnose: 2,
  },
});

function operationRoute(tool, handler) {
  return async (req, res) => {
    const requestId = createRequestId();
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Request-Id', requestId);

    const release = operationLimiter.acquire(tool);
    if (!release) {
      res.set('Retry-After', '2');
      return res.status(429).json({
        schema_version: 2,
        request_id: requestId,
        tool,
        ok: false,
        status: 'busy',
        error: 'This diagnostic is already busy. Try again shortly.',
        diagnosis: {
          code: 'TOOL_BUSY',
          severity: 'warning',
          summary: 'This diagnostic is already busy. Try again shortly.',
        },
      });
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    res.once('close', () => {
      if (!res.writableEnded) abort();
    });

    try {
      await handler(req, res, { requestId, signal: controller.signal });
    } catch (error) {
      if (!controller.signal.aborted && !res.headersSent) sendRouteError(res, error, requestId, tool);
    } finally {
      req.removeListener('aborted', abort);
      release();
    }
  };
}

function privateNoStore(_req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  next();
}

function requestValue(req, bodyKey, queryKey = bodyKey) {
  return req.method === 'POST' ? req.body?.[bodyKey] : req.query?.[queryKey];
}

function parseBooleanValue(value, fieldName = 'value') {
  if (value == null || value === '' || value === false || value === 0) return false;
  if (value === true || value === 1) return true;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new ToolInputError('INVALID_BOOLEAN', `${fieldName} must be true or false.`);
}

function requestBoolean(req, bodyKey, queryKey = bodyKey) {
  return parseBooleanValue(requestValue(req, bodyKey, queryKey), bodyKey);
}

async function handlePing(req, res, { requestId, signal }) {
  const target = normalizeTarget(requestValue(req, 'target', 'host'));
  const payload = await runPingDiagnostic(target, {
    requestId,
    signal,
    count: requestValue(req, 'count'),
    replyTimeout: requestValue(req, 'reply_timeout'),
  });
  if (!signal.aborted && payload) res.json(payload);
}

async function handleTrace(req, res, { requestId, signal }) {
  const target = normalizeTarget(requestValue(req, 'target', 'host'));
  const payload = await runTraceDiagnostic(target, {
    requestId,
    signal,
    maxHops: requestValue(req, 'max_hops'),
    mode: requestValue(req, 'mode'),
  });
  if (!signal.aborted && payload) res.json(payload);
}

async function handleDns(req, res, { requestId, signal }) {
  const target = normalizeTarget(requestValue(req, 'target', 'host'), { allowUnderscore: true });
  const payload = await runDnsDiagnostic(target, {
    requestId,
    signal,
    recordType: requestValue(req, 'type'),
  });
  if (!signal.aborted && payload) res.json(payload);
}

async function handlePortScan(req, res, { requestId, signal }) {
  const target = normalizeTarget(requestValue(req, 'target', 'host'));
  const payload = await runPortScanDiagnostic(target, {
    requestId,
    signal,
    ports: requestValue(req, 'ports'),
    timeoutMs: requestValue(req, 'timeout_ms'),
  });
  if (!signal.aborted && payload) res.json(payload);
}

async function handleDiagnosis(req, res, { requestId, signal }) {
  const target = normalizeTarget(requestValue(req, 'target', 'host'));
  const payload = await runNetworkDiagnosis(target, {
    requestId,
    signal,
    includeTrace: requestBoolean(req, 'include_trace'),
    maxHops: requestValue(req, 'max_hops'),
    traceMode: requestValue(req, 'trace_mode'),
  });
  if (!signal.aborted && payload) res.json(payload);
}

function setupNetworkToolRoutes(app, requireAuth) {
  // Ping
  app.get('/api/tools/ping', privateNoStore, requireAuth, operationRoute('ping', handlePing));
  app.post('/api/tools/v2/ping', privateNoStore, requireAuth, operationRoute('ping', handlePing));

  // Traceroute
  app.get('/api/tools/traceroute', privateNoStore, requireAuth, operationRoute('traceroute', handleTrace));
  app.post('/api/tools/v2/trace', privateNoStore, requireAuth, operationRoute('traceroute', handleTrace));

  // DNS lookup
  app.get('/api/tools/dns', privateNoStore, requireAuth, operationRoute('dns', handleDns));
  app.post('/api/tools/v2/dns', privateNoStore, requireAuth, operationRoute('dns', handleDns));

  // Whois
  app.get('/api/tools/whois', privateNoStore, requireAuth, operationRoute('whois', async (req, res, { requestId, signal }) => {
    let target;
    try { target = normalizeTarget(req.query.domain); } catch (error) { return sendRouteError(res, error, requestId, 'whois'); }
    const domain = target.host;
    const whois = findExecutable(['whois']);
    if (!whois) return res.status(500).json({ domain, output: 'whois command not installed.' });
    const result = await runCommand(whois, [domain], { timeoutMs: 15000, signal });
    if (signal.aborted) return;
    const output = commandOutput(result);
    res.json({ domain, output });
  }));

  // Port scan (basic common ports)
  app.get('/api/tools/portscan', privateNoStore, requireAuth, operationRoute('portscan', handlePortScan));
  app.post('/api/tools/v2/port-scan', privateNoStore, requireAuth, operationRoute('portscan', handlePortScan));

  // Unified diagnosis
  app.post('/api/tools/v2/diagnose', privateNoStore, requireAuth, operationRoute('diagnose', handleDiagnosis));
}

module.exports = { parseBooleanValue, setupNetworkToolRoutes };
