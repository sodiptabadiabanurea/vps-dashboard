'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isObserverNoise } = require('../collectors/processes');

test('process collector excludes its own sampling and capacity probes', () => {
  assert.equal(isObserverNoise('sh -c ps aux --sort=-%cpu | head -31 | tail -30'), true);
  assert.equal(isObserverNoise('du -sh /home/dipta /opt /var/cache /var/log /tmp'), true);
  assert.equal(isObserverNoise('sh -c apt list --upgradable | grep -c security'), true);
  assert.equal(isObserverNoise('/usr/bin/node server.js'), false);
  assert.equal(isObserverNoise('/usr/bin/du -sh /srv/customer-data'), false);
});
