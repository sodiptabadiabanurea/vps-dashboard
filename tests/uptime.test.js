'use strict';

process.env.DASHBOARD_PASS = 'test-only-password';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyUptimeTransition, createSingleFlight } = require('../uptime');

test('uptime transition records only down and recovery edges', () => {
  assert.equal(classifyUptimeTransition(null, 200), null);
  assert.equal(classifyUptimeTransition(null, 500), 'down');
  assert.equal(classifyUptimeTransition(200, 503), 'down');
  assert.equal(classifyUptimeTransition(503, 0), null);
  assert.equal(classifyUptimeTransition(503, 200), 'recovered');
  assert.equal(classifyUptimeTransition(404, 200), null);
});

test('uptime scheduler coalesces concurrent cycle requests', async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const run = createSingleFlight(async () => {
    calls += 1;
    await gate;
    return calls;
  });
  const first = run();
  const second = run();
  assert.equal(first, second);
  assert.equal(calls, 0);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.equal(await first, 1);
});
