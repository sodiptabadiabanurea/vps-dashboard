'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildProcessDiff,
  buildThresholdPolicy,
  evaluateMissionState,
  stabilizeMissionState,
  buildMissionControlSnapshot,
  enrichTimeline,
} = require('../modules/mission-control');

test('process diff establishes a baseline without false changes', () => {
  const diff = buildProcessDiff([], [{ pid: 10, name: 'node', cpu: 12 }], 1000);
  assert.equal(diff.baseline, true);
  assert.deepEqual(diff.counts, { entered: 0, left: 0, cpu_spikes: 0, memory_spikes: 0 });
});

test('mission thresholds derive incident levels from alert policy', () => {
  const policy = buildThresholdPolicy([
    { type: 'cpu', threshold: 88 },
    { type: 'ram', threshold: 86 },
  ]);
  assert.deepEqual(policy.cpu, { attention: 73, incident: 88 });
  assert.deepEqual(policy.ram, { attention: 76, incident: 86 });
  assert.deepEqual(policy.disk, { attention: 80, incident: 90 });
});

test('mission threshold policy clamps invalid stored values', () => {
  const policy = buildThresholdPolicy([
    { type: 'cpu', threshold: -5 },
    { type: 'disk', threshold: 500 },
  ]);
  assert.deepEqual(policy.cpu, { attention: 0, incident: 1 });
  assert.deepEqual(policy.disk, { attention: 90, incident: 100 });
});

test('process diff reports top-sample entry, exit, and CPU jump', () => {
  const previous = [
    { pid: 10, name: 'node', cpu: 12, mem: 1, rss: 1000 },
    { pid: 11, name: 'python', cpu: 8, mem: 1, rss: 1000 },
  ];
  const current = [
    { pid: 10, name: 'node', cpu: 46, mem: 1, rss: 1000 },
    { pid: 12, name: 'nginx', cpu: 3, mem: 1, rss: 1000 },
  ];
  const diff = buildProcessDiff(previous, current, 2000);
  assert.equal(diff.baseline, false);
  assert.equal(diff.entered[0].name, 'nginx');
  assert.equal(diff.left[0].name, 'python');
  assert.equal(diff.cpu_spikes[0].delta_cpu, 34);
  assert.equal(diff.scope, 'top-process-sample');
});

test('process diff counts all changes while bounding display evidence', () => {
  const previous = Array.from({ length: 10 }, (_, index) => ({ pid: index + 1, name: `old-${index}` }));
  const current = Array.from({ length: 10 }, (_, index) => ({ pid: index + 101, name: `new-${index}` }));
  const diff = buildProcessDiff(previous, current, 3000);
  assert.equal(diff.counts.entered, 10);
  assert.equal(diff.counts.left, 10);
  assert.equal(diff.entered.length, 6);
  assert.equal(diff.left.length, 6);
});

test('stale service and process evidence cannot keep an incident active', () => {
  const now = 100000;
  const state = evaluateMissionState({
    metrics: { ts: now - 1000, cpu: 12, ram_percent: 40, swap_percent: 0 },
    services: { ssh: { active: true }, nginx: { active: false }, fail2ban: { active: true } },
    disk: { filesystems: [{ mount: '/', percent: 40 }] },
    processDiff: {
      observed_at: now - 25000,
      cpu_spikes: [{ pid: 7, name: 'worker', cpu: 99, delta_cpu: 40 }],
    },
    sourceTimestamps: {
      metrics: now - 1000,
      processes: now - 25000,
      services: now - 35000,
      disk: now - 1000,
    },
    now,
  });
  assert.equal(state.level, 'attention');
  assert.equal(state.primary_signal.key, 'telemetry');
  assert.deepEqual(state.inactive_services, []);
  assert.deepEqual(state.last_known_inactive_services, ['nginx']);
});

test('per-process CPU above 100 percent is evidence, not an incident by itself', () => {
  const now = 100000;
  const state = evaluateMissionState({
    metrics: { ts: now - 1000, cpu: 20, ram_percent: 30, swap_percent: 0 },
    services: { ssh: { active: true }, nginx: { active: true }, fail2ban: { active: true } },
    disk: { filesystems: [{ mount: '/', percent: 40 }] },
    processDiff: { observed_at: now - 1000, cpu_spikes: [{ pid: 8, name: 'worker', cpu: 132, delta_cpu: 40 }] },
    sourceTimestamps: { metrics: now - 1000, processes: now - 1000, services: now - 1000, disk: now - 1000 },
    now,
  });
  assert.equal(state.level, 'attention');
  assert.equal(state.primary_signal.key, 'processes');
});

test('mission state becomes offline when telemetry is stale', () => {
  const state = evaluateMissionState({ metrics: { ts: 1000, cpu: 1 }, now: 20000 });
  assert.equal(state.level, 'offline');
  assert.match(state.headline, /stale/i);
});

test('mission state prioritizes incident CPU with deterministic advice', () => {
  const now = 100000;
  const state = evaluateMissionState({
    metrics: { ts: now - 1000, cpu: 94, ram_percent: 40, swap_percent: 0 },
    services: { ssh: { active: true }, nginx: { active: true }, fail2ban: { active: true } },
    disk: { filesystems: [{ mount: '/', percent: 45 }] },
    now,
  });
  assert.equal(state.level, 'incident');
  assert.equal(state.primary_signal.key, 'cpu');
  assert.match(state.recommendation, /Process Diff/i);
});

test('critical service outage outranks simultaneous resource saturation', () => {
  const now = 100000;
  const state = evaluateMissionState({
    metrics: { ts: now - 1000, cpu: 94, ram_percent: 40, swap_percent: 0 },
    services: { ssh: { active: true }, nginx: { active: false }, fail2ban: { active: true } },
    disk: { filesystems: [{ mount: '/', percent: 45 }] },
    sourceTimestamps: { metrics: now - 1000, processes: now - 1000, services: now - 1000, disk: now - 1000 },
    processDiff: { observed_at: now - 1000 },
    now,
  });
  assert.equal(state.level, 'incident');
  assert.equal(state.primary_signal.key, 'services');
});

test('mission state does not claim healthy while collector coverage is incomplete', () => {
  const now = 100000;
  const state = evaluateMissionState({
    metrics: { ts: now - 1000, cpu: 12, ram_percent: 40, swap_percent: 0 },
    sourceTimestamps: { metrics: now - 1000, processes: 0, services: 0, disk: 0 },
    now,
  });
  assert.equal(state.level, 'attention');
  assert.ok(state.unavailable_sources.includes('services'));
  assert.match(state.headline, /incomplete/i);
});

test('mission state treats missing disk data as incomplete even after a collector tick', () => {
  const now = 100000;
  const state = evaluateMissionState({
    metrics: { ts: now - 1000, cpu: 12, ram_percent: 40, swap_percent: 0 },
    services: { ssh: { active: true }, nginx: { active: true }, fail2ban: { active: true } },
    processDiff: buildProcessDiff([], [], now - 1000),
    sourceTimestamps: { metrics: now - 1000, processes: now - 1000, services: now - 1000, disk: now - 1000 },
    disk: { filesystems: [] },
    now,
  });
  assert.equal(state.level, 'attention');
  assert.ok(state.unavailable_sources.includes('disk'));
  assert.equal(state.source_status.disk.state, 'missing');
});

test('mission state dwell suppresses threshold flapping and delays recovery', () => {
  const runtime = {};
  const healthy = { level: 'healthy', metrics: { cpu: 20 } };
  const incident = { level: 'incident', metrics: { cpu: 91 } };

  assert.equal(stabilizeMissionState(runtime, healthy, 1000).level, 'healthy');
  assert.equal(stabilizeMissionState(runtime, incident, 2000).level, 'healthy');
  assert.equal(stabilizeMissionState(runtime, healthy, 3000).level, 'healthy');
  assert.equal(stabilizeMissionState(runtime, incident, 4000).level, 'healthy');
  assert.equal(stabilizeMissionState(runtime, incident, 8000).level, 'incident');
  assert.equal(stabilizeMissionState(runtime, healthy, 9000).level, 'incident');
  assert.equal(stabilizeMissionState(runtime, healthy, 15000).level, 'healthy');
});

test('snapshot excludes full command lines and includes causal evidence', () => {
  const now = 1_000_000;
  const snapshot = buildMissionControlSnapshot({
    metrics: { ts: now - 1000, cpu: 82, ram_percent: 40, swap_percent: 0 },
    processes: [{ pid: 7, name: '<worker>', cmd: '/private/secret --token=abc', cpu: 55, mem: 2 }],
    services: { ssh: { active: true }, nginx: { active: true }, fail2ban: { active: true } },
    disk: { filesystems: [{ mount: '/', percent: 45 }], topDirs: [{ path: '/opt', size: '2G' }] },
    history: [{ ts: Math.floor(now / 1000) - 60, cpu: 20, ram_used: 20, ram_total: 100 }],
    timeline: [{ id: 1, ts: Math.floor(now / 1000) - 30, category: 'deploy', title: 'Deploy complete', detail: 'release', source: 'deploy' }],
    processDiff: buildProcessDiff([], [], now),
    now,
    revision: 9,
    bootId: 'test-boot',
  });
  assert.equal(snapshot.schema_version, 1);
  assert.equal(snapshot.revision, 9);
  assert.equal(snapshot.boot_id, 'test-boot');
  assert.equal(snapshot.causal_events[0].phase, 'change');
  assert.match(snapshot.explanations.cpu.summary, /<worker>/);
  assert.equal(JSON.stringify(snapshot).includes('--token=abc'), false);
});

test('snapshot state and explanations use the same custom threshold policy', () => {
  const now = 1_000_000;
  const thresholds = buildThresholdPolicy([{ type: 'cpu', threshold: 88 }]);
  const snapshot = buildMissionControlSnapshot({
    metrics: { ts: now - 1000, cpu: 89, ram_percent: 20, swap_percent: 0 },
    processes: [{ pid: 1, name: 'worker', cpu: 20, mem: 1 }],
    services: { ssh: { active: true }, nginx: { active: true }, fail2ban: { active: true } },
    disk: { filesystems: [{ mount: '/', percent: 20 }] },
    processDiff: { observed_at: now - 1000, baseline: false, cpu_spikes: [] },
    sourceTimestamps: { metrics: now - 1000, processes: now - 1000, services: now - 1000, disk: now - 1000 },
    thresholds,
    now,
  });
  assert.equal(snapshot.level, 'incident');
  assert.equal(snapshot.explanations.cpu.evidence[0].tone, 'incident');
});

test('timeline enrichment classifies recovery before generic impact', () => {
  const events = enrichTimeline([
    { id: 1, ts: 90, category: 'uptime', title: 'Service restored', detail: 'back online' },
    { id: 2, ts: 80, category: 'alert', title: 'CPU high' },
  ], 100000);
  assert.equal(events[0].phase, 'recovery');
  assert.equal(events[1].phase, 'trigger');
});

test('timeline enrichment respects explicit operational phases', () => {
  const events = enrichTimeline([
    { id: 3, ts: 90, category: 'service', title: 'nginx restart completed', metadata: JSON.stringify({ phase: 'change', correlation_id: 'action-1' }) },
  ], 100000);
  assert.equal(events[0].phase, 'change');
  assert.equal(events[0].correlation_id, 'action-1');
});
