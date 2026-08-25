'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_INCIDENTS,
  buildChartHistory,
  validateChartHistoryQuery,
} = require('../modules/chart-history');

function metric(ts, overrides = {}) {
  return {
    ts,
    cpu: 10,
    ram_used: 40,
    ram_total: 100,
    swap_used: 0,
    swap_total: 100,
    disk_used: 50,
    disk_total: 100,
    net_rx: ts * 10,
    net_tx: ts * 5,
    ...overrides,
  };
}

test('chart query validation applies defaults and returns a stable 400 envelope', () => {
  assert.deepEqual(validateChartHistoryQuery({}), {
    ok: true,
    value: { range: '6h', maxPoints: 720 },
  });
  assert.deepEqual(validateChartHistoryQuery({ range: '30d', max_points: '1200' }), {
    ok: true,
    value: { range: '30d', maxPoints: 1200 },
  });
  assert.deepEqual(validateChartHistoryQuery({ range: 'forever', max_points: '12.5' }), {
    ok: false,
    status: 400,
    body: {
      error: {
        code: 'INVALID_CHART_HISTORY_QUERY',
        message: 'Invalid chart history query',
        fields: {
          range: 'Must be one of: 1h, 6h, 24h, 7d, 30d',
          max_points: 'Must be an integer from 240 to 1200',
        },
      },
    },
  });
});

test('chart history remains below the requested point bound', () => {
  const now = 2592000;
  const rows = [];
  for (let ts = 0; ts <= now; ts += 60) rows.push(metric(ts));

  const result = buildChartHistory({ rows, range: '30d', maxPoints: 240, now });
  assert.ok(result.samples.length <= 240);
  assert.equal(result.source_count, rows.length);
  assert.ok(result.resolution_seconds >= 10800);
});

test('bucket maxima retain short spikes that averages smooth out', () => {
  const now = 86400;
  const rows = [
    metric(120, { cpu: 10 }),
    metric(180, { cpu: 100 }),
    metric(240, { cpu: 10 }),
  ];

  const result = buildChartHistory({ rows, range: '24h', maxPoints: 240, now });
  const spikeBucket = result.samples.find(sample => sample.cpu_max === 100);
  assert.ok(spikeBucket);
  assert.equal(spikeBucket.cpu_avg, 40);
});

test('network counter resets produce gaps instead of false zero spikes', () => {
  const rows = [
    metric(0, { net_rx: 1000, net_tx: 500 }),
    metric(60, { net_rx: 1600, net_tx: 800 }),
    metric(120, { net_rx: 100, net_tx: 50 }),
    metric(180, { net_rx: 700, net_tx: 350 }),
  ];

  const result = buildChartHistory({ rows, range: '1h', maxPoints: 240, now: 3600 });
  const byTimestamp = new Map(result.samples.map(sample => [sample.ts, sample]));
  assert.equal(byTimestamp.get(60).net_rx_avg, 10);
  assert.equal(byTimestamp.get(120).net_rx_avg, null);
  assert.equal(byTimestamp.get(120).net_tx_avg, null);
  assert.equal(byTimestamp.get(180).net_rx_avg, 10);
  assert.equal(result.summaries.network.avg.rx, 10);
  assert.equal(result.summaries.network.peak.rx, 10);
});

test('network averages are weighted by elapsed interval duration', () => {
  const rows = [
    metric(0, { net_rx: 0, net_tx: 0 }),
    metric(10, { net_rx: 100, net_tx: 200 }),
    metric(50, { net_rx: 140, net_tx: 280 }),
  ];

  const result = buildChartHistory({ rows, range: '1h', maxPoints: 240, now: 3600 });
  const firstBucket = result.samples.find(sample => sample.ts === 0);
  assert.equal(firstBucket.net_rx_avg, 2.8);
  assert.equal(firstBucket.net_tx_avg, 5.6);
  assert.deepEqual(result.summaries.network.current, { rx: 1, tx: 2 });
  assert.deepEqual(result.summaries.network.avg, { rx: 2.8, tx: 5.6 });
  assert.deepEqual(result.summaries.network.peak, { rx: 10, tx: 20 });
});

test('zero swap capacity stays null instead of manufacturing utilization', () => {
  const result = buildChartHistory({
    rows: [metric(60, { swap_used: 25, swap_total: 0 })],
    range: '1h',
    maxPoints: 240,
    now: 3600,
  });

  assert.equal(result.samples[0].swap_avg, null);
  assert.equal(result.samples[0].swap_max, null);
  assert.equal(result.summaries.swap.current, null);
  assert.equal(result.summaries.swap.avg, null);
  assert.equal(result.summaries.swap.peak, null);
});

test('summaries use raw samples, configured thresholds, and latest rates', () => {
  const rows = [
    metric(0, { cpu: 10, ram_used: 20, disk_used: 30, swap_used: 0, net_rx: 0, net_tx: 0 }),
    metric(60, { cpu: 30, ram_used: 40, disk_used: 50, swap_used: 10, net_rx: 600, net_tx: 1200 }),
    metric(120, { cpu: 80, ram_used: 60, disk_used: 70, swap_used: 20, net_rx: 2400, net_tx: 3000 }),
  ];
  const alertConfig = [
    { type: 'cpu', enabled: 1, threshold: 90 },
    { type: 'ram', enabled: 1, threshold: 85 },
    { type: 'disk', enabled: 0, threshold: 88 },
    { type: 'swap', enabled: 1, threshold: 50 },
  ];

  const result = buildChartHistory({ rows, alertConfig, range: '1h', maxPoints: 240, now: 3600 });
  assert.deepEqual(result.summaries.cpu, {
    current: 80,
    avg: 40,
    peak: 80,
    threshold: 90,
    unit: 'percent',
  });
  assert.equal(result.summaries.ram.current, 60);
  assert.equal(result.summaries.disk.peak, 70);
  assert.equal(result.summaries.disk.threshold, null);
  assert.equal(result.summaries.swap.avg, 10);
  assert.deepEqual(result.summaries.network.current, { rx: 30, tx: 30 });
  assert.deepEqual(result.summaries.network.avg, { rx: 20, tx: 25 });
  assert.deepEqual(result.summaries.network.peak, { rx: 30, tx: 30 });
});

test('empty chart history keeps a complete null-safe contract', () => {
  const result = buildChartHistory({
    rows: [],
    alertConfig: [{ type: 'cpu', threshold: 91 }],
    range: '6h',
    maxPoints: 720,
    now: 100000,
  });

  assert.equal(result.schema, 'charts-history.v2');
  assert.equal(result.schema_version, 2);
  assert.equal(result.source_count, 0);
  assert.equal(result.latest_sample_at, null);
  assert.deepEqual(result.samples, []);
  assert.deepEqual(result.incidents, []);
  assert.deepEqual(result.summaries.cpu, {
    current: null,
    avg: null,
    peak: null,
    threshold: 91,
    unit: 'percent',
  });
  assert.deepEqual(result.summaries.network.current, { rx: null, tx: null });
});

test('incidents are bounded to the latest entries and returned chronologically', () => {
  const incidents = Array.from({ length: MAX_INCIDENTS + 20 }, (_, index) => ({
    ts: 1000 + index,
    type: 'cpu',
    message: `incident-${index}`,
    value: 90 + (index % 5),
    threshold: 90,
  })).reverse();

  const result = buildChartHistory({
    rows: [],
    incidents,
    range: '1h',
    maxPoints: 240,
    now: 4600,
  });
  assert.equal(result.incidents.length, MAX_INCIDENTS);
  assert.equal(result.incident_counts.cpu, MAX_INCIDENTS + 20);
  assert.equal(result.incidents[0].message, 'incident-20');
  assert.equal(result.incidents.at(-1).message, `incident-${MAX_INCIDENTS + 19}`);
  assert.ok(result.incidents.every((incident, index, list) => index === 0 || incident.ts >= list[index - 1].ts));
});

test('incident bounding preserves the latest event for every represented metric', () => {
  const incidents = [
    { id: 1, ts: 1000, type: 'ram', message: 'ram-only', value: 86, threshold: 85 },
    ...Array.from({ length: 600 }, (_, index) => ({
      id: index + 2,
      ts: 1001 + index,
      type: 'cpu',
      message: `cpu-${index}`,
      value: 91,
      threshold: 90,
    })),
  ];

  const result = buildChartHistory({ incidents, range: '1h', maxPoints: 240, now: 4600 });
  assert.equal(result.incidents.length, MAX_INCIDENTS);
  assert.equal(result.incident_counts.cpu, 600);
  assert.equal(result.incident_counts.ram, 1);
  assert.ok(result.incidents.some(incident => incident.metric === 'ram' && incident.message === 'ram-only'));
  assert.equal(result.incidents.filter(incident => incident.metric === 'cpu').length, MAX_INCIDENTS - 1);
});

test('equal-timestamp incidents use ascending source id for stable chronology', () => {
  const result = buildChartHistory({
    incidents: [
      { id: 2, ts: 1000, type: 'cpu', message: 'second' },
      { id: 1, ts: 1000, type: 'cpu', message: 'first' },
    ],
    range: '1h',
    maxPoints: 240,
    now: 4600,
  });

  assert.deepEqual(result.incidents.map(incident => incident.message), ['first', 'second']);
});
