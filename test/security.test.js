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
