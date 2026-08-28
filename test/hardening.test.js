const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');


test('SSL SSRF guard blocks private and IPv4-mapped private addresses', () => {
  const { isPrivateAddress } = require('../modules/ssl');

  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('10.0.0.1'), true);
  assert.equal(isPrivateAddress('169.254.169.254'), true);
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('fc00::1'), true);
  assert.equal(isPrivateAddress('fe80::1'), true);
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateAddress('::ffff:192.168.1.1'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
});


test('backup filenames are constrained to generated backup names', () => {
  const { isBackupName, backupPath } = require('../modules/backup');

  assert.equal(isBackupName('vps-dashboard-backup-2026-08-28T07-22-32.tar.gz'), true);
  assert.equal(isBackupName('../vps-dashboard-backup-2026-08-28T07-22-32.tar.gz'), false);
  assert.equal(isBackupName('vps-dashboard-backup-2026-08-28T07-22-32.tar.gz/../../etc/passwd'), false);
  assert.equal(isBackupName('anything.tar.gz'), false);
  assert.throws(() => backupPath('../etc/passwd'), /Invalid backup name/);
});


test('backup module uses direct tar execution rather than a shell command', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'modules', 'backup.js'), 'utf8');
  assert.match(source, /execFile\(/);
  assert.doesNotMatch(source, /\bexec\(/);
});
