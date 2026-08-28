const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function configResult(pass, user = 'admin') {
  const env = {
    ...process.env,
    DASHBOARD_USER: user,
    DASHBOARD_PASS: pass,
  };
  return spawnSync(process.execPath, ['-e', "require('./config')"], { env, encoding: 'utf8' });
}

test('dashboard credentials fail closed when missing', () => {
  const env = { ...process.env };
  delete env.DASHBOARD_USER;
  delete env.DASHBOARD_PASS;
  const result = spawnSync(process.execPath, ['-e', "require('./config')"], { env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
});

test('dashboard credentials reject weak passwords', () => {
  assert.notEqual(configResult('a'.repeat(31)).status, 0);
  assert.notEqual(configResult('changeme').status, 0);
});

test('dashboard credentials accept a strong password', () => {
  assert.equal(configResult('a'.repeat(32)).status, 0);
});

test('Docker container names are strictly validated', () => {
  const { validateContainerName } = require('../docker');
  assert.equal(validateContainerName('nginx_prod-1'), 'nginx_prod-1');
  assert.throws(() => validateContainerName('nginx;id'));
  assert.throws(() => validateContainerName('nginx && id'));
});

test('network host validation rejects shell metacharacters', () => {
  const { sanitizeHost, ALLOWED_DNS_TYPES } = require('../modules/network-tools');
  assert.equal(sanitizeHost('example.com'), 'example.com');
  assert.equal(sanitizeHost('example.com;id'), '');
  assert.equal(sanitizeHost('example.com$(id)'), '');
  assert.equal(ALLOWED_DNS_TYPES.has('A'), true);
  assert.equal(ALLOWED_DNS_TYPES.has('A;id'), false);
});

test('file manager rejects traversal and symlink escapes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-dashboard-test-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-dashboard-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, path.join(root, 'escape'), 'dir');

  process.env.FM_ROOT = root;
  const { safePath, safePathNoSymlink, safeUploadName } = require('../filemanager');

  assert.throws(() => safePath('../outside'));
  assert.throws(() => safePath('escape/secret.txt'));
  assert.throws(() => safePathNoSymlink('escape'));
  assert.equal(safeUploadName('../report.txt'), 'report.txt');
  assert.throws(() => safeUploadName(''));

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('terminal parses Basic credentials without shell execution', () => {
  process.env.DASHBOARD_USER = 'admin';
  process.env.DASHBOARD_PASS = 'a'.repeat(32);
  const { parseBasicCredentials } = require('../terminal');
  const header = `Basic ${Buffer.from('admin:' + 'a'.repeat(32)).toString('base64')}`;
  assert.deepEqual(parseBasicCredentials(header), { user: 'admin', pass: 'a'.repeat(32) });
  assert.equal(parseBasicCredentials('Bearer token'), null);
});

test('static shell and socket transport stay behind Basic Auth', async () => {
  // Regression test for the PR #1 bug: the socket.io middleware rejected
  // browsers whose Authorization header never got attached (shell was public,
  // so no 401 challenge was ever issued). Gating the static shell restores
  // the browser credential cache for same-origin socket.io polling requests.
  const port = 3199;
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vps-dashboard-auth-')), 'test.db');
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DB_PATH: dbPath,
    DASHBOARD_USER: 'admin',
    DASHBOARD_PASS: 'a'.repeat(32),
  };
  const child = require('child_process').spawn(process.execPath, ['server.js'], {
    env,
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childErr = '';
  child.stdout.on('data', (d) => { childErr += d.toString(); });
  child.stderr.on('data', (d) => { childErr += d.toString(); });
  const base = `http://127.0.0.1:${port}`;
  const auth = `Basic ${Buffer.from('admin:' + 'a'.repeat(32)).toString('base64')}`;

  try {
    // Wait for the server to listen.
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try {
        await fetch(`${base}/healthz`);
        up = true;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    assert.equal(up, true, `server did not start; child output: ${childErr.slice(0, 800)}`);

    // Liveness probe stays public and carries no data.
    assert.equal((await fetch(`${base}/healthz`)).status, 200);

    // Static shell must challenge unauthenticated browsers.
    const anonShell = await fetch(`${base}/`);
    assert.equal(anonShell.status, 401);
    assert.match(anonShell.headers.get('www-authenticate') || '', /Basic/);

    // Authenticated browsers get the shell.
    assert.equal((await fetch(`${base}/`, { headers: { Authorization: auth } })).status, 200);

    // socket.io namespace connect must reject unauthenticated transports.
    // The engine handshake is unauthenticated by design; the auth boundary
    // fires when the client attaches to the namespace (packet '40').
    const anonEngine = await fetch(`${base}/socket.io/?EIO=4&transport=polling`);
    assert.equal(anonEngine.status, 200);
    const anonSid = JSON.parse((await anonEngine.text()).slice(1)).sid;
    const anonPost = await fetch(`${base}/socket.io/?EIO=4&transport=polling&sid=${anonSid}`, {
      method: 'POST',
      body: '40',
    });
    assert.equal(anonPost.status, 200);
    const anonNs = await fetch(`${base}/socket.io/?EIO=4&transport=polling&sid=${anonSid}`);
    assert.match(await anonNs.text(), /Authentication required/);

    // Authenticated handshake + namespace connect succeeds and streams packets.
    const authEngine = await fetch(`${base}/socket.io/?EIO=4&transport=polling`, {
      headers: { Authorization: auth },
    });
    assert.equal(authEngine.status, 200);
    const authSid = JSON.parse((await authEngine.text()).slice(1)).sid;
    const authPost = await fetch(`${base}/socket.io/?EIO=4&transport=polling&sid=${authSid}`, {
      method: 'POST',
      body: '40',
      headers: { Authorization: auth },
    });
    assert.equal(authPost.status, 200);
    const authNs = await fetch(`${base}/socket.io/?EIO=4&transport=polling&sid=${authSid}`, {
      headers: { Authorization: auth },
    });
    assert.match(await authNs.text(), /40\{"sid"/);

    // Client transport is pinned to authenticated long-polling.
    const socketJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'socket.js'), 'utf8');
    assert.match(socketJs, /transports:\s*\['polling'\]/);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('CSRF guard rejects cross-origin state-changing requests', () => {
  const { csrfProtection } = require('../csrf');
  const makeReq = (headers) => ({ method: 'POST', headers, get(name) { return this.headers[name.toLowerCase()]; }, protocol: 'https' });
  const makeRes = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } });

  const crossSite = makeRes();
  csrfProtection(makeReq({ host: 'dashboard.example.com', 'sec-fetch-site': 'cross-site' }), crossSite, () => { throw new Error('next() should not be called'); });
  assert.equal(crossSite.statusCode, 403);

  const badOrigin = makeRes();
  csrfProtection(makeReq({ host: 'dashboard.example.com', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }), badOrigin, () => { throw new Error('next() should not be called'); });
  assert.equal(badOrigin.statusCode, 403);
});

test('CSRF guard accepts same-origin and non-browser state-changing requests', () => {
  const { csrfProtection } = require('../csrf');
  const makeReq = (headers) => ({ method: 'POST', headers, get(name) { return this.headers[name.toLowerCase()]; }, protocol: 'https' });
  const makeRes = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json() { return this; } });

  let called = false;
  const sameOrigin = makeRes();
  csrfProtection(makeReq({ host: 'dashboard.example.com', origin: 'https://dashboard.example.com', 'sec-fetch-site': 'same-origin' }), sameOrigin, () => { called = true; });
  assert.equal(called, true);
  assert.equal(sameOrigin.statusCode, 200);

  called = false;
  const nonBrowser = makeRes();
  csrfProtection(makeReq({ host: 'dashboard.example.com' }), nonBrowser, () => { called = true; });
  assert.equal(called, true);
  assert.equal(nonBrowser.statusCode, 200);
});

test('CSRF guard validates Referer and malformed Origin', () => {
  const { csrfProtection } = require('../csrf');
  const makeReq = (headers) => ({ method: 'POST', headers, get(name) { return this.headers[name.toLowerCase()]; }, protocol: 'https' });
  const makeRes = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } });

  const validReferer = makeRes();
  let called = false;
  csrfProtection(makeReq({ host: 'dashboard.example.com', referer: 'https://dashboard.example.com/settings', 'sec-fetch-site': 'same-origin' }), validReferer, () => { called = true; });
  assert.equal(called, true);

  const malformedOrigin = makeRes();
  csrfProtection(makeReq({ host: 'dashboard.example.com', origin: 'null', 'sec-fetch-site': 'same-origin' }), malformedOrigin, () => { throw new Error('next() should not be called'); });
  assert.equal(malformedOrigin.statusCode, 403);
});
