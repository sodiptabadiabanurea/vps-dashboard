'use strict';

const RANGE_SECONDS = Object.freeze({
  '1h': 3600,
  '6h': 21600,
  '24h': 86400,
  '7d': 604800,
  '30d': 2592000,
});

const DEFAULT_RANGE = '6h';
const DEFAULT_MAX_POINTS = 720;
const MIN_MAX_POINTS = 240;
const MAX_MAX_POINTS = 1200;
const MAX_INCIDENTS = 500;
const NICE_BUCKET_SECONDS = Object.freeze([
  60,
  120,
  300,
  600,
  900,
  1800,
  3600,
  7200,
  10800,
  14400,
  21600,
  43200,
  86400,
]);

const SERIES_KEYS = Object.freeze([
  'cpu',
  'ram',
  'disk',
  'swap',
  'net_rx',
  'net_tx',
]);

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percentage(used, total) {
  const usedValue = numeric(used);
  const totalValue = numeric(total);
  if (usedValue === null || totalValue === null || totalValue <= 0) return null;
  return Math.min(100, Math.max(0, (usedValue / totalValue) * 100));
}

function percentValue(value) {
  const number = numeric(value);
  return number === null ? null : Math.min(100, Math.max(0, number));
}

function round(value, precision = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function createStats() {
  return { sum: 0, weight: 0, count: 0, max: null };
}

function addStats(stats, value, weight = 1) {
  if (!Number.isFinite(value)) return;
  const safeWeight = Number.isFinite(weight) && weight > 0 ? weight : 1;
  stats.sum += value * safeWeight;
  stats.weight += safeWeight;
  stats.count += 1;
  stats.max = stats.max === null ? value : Math.max(stats.max, value);
}

function average(stats) {
  return stats.weight ? round(stats.sum / stats.weight) : null;
}

function peak(stats) {
  return stats.max === null ? null : round(stats.max);
}

function chooseResolution(rangeSeconds, maxPoints) {
  // Epoch-aligned buckets can touch both range boundaries. Reserving one point
  // for that inclusive edge guarantees the response never exceeds maxPoints.
  const minimum = Math.ceil(rangeSeconds / Math.max(1, maxPoints - 1));
  return NICE_BUCKET_SECONDS.find(seconds => seconds >= minimum)
    || NICE_BUCKET_SECONDS[NICE_BUCKET_SECONDS.length - 1];
}

function validationError(fields) {
  return {
    ok: false,
    status: 400,
    body: {
      error: {
        code: 'INVALID_CHART_HISTORY_QUERY',
        message: 'Invalid chart history query',
        fields,
      },
    },
  };
}

function validateChartHistoryQuery(query = {}) {
  const fields = {};
  const rawRange = query.range === undefined ? DEFAULT_RANGE : query.range;
  const rawMaxPoints = query.max_points === undefined ? DEFAULT_MAX_POINTS : query.max_points;

  if (typeof rawRange !== 'string' || !Object.hasOwn(RANGE_SECONDS, rawRange)) {
    fields.range = 'Must be one of: 1h, 6h, 24h, 7d, 30d';
  }

  const maxPointsText = typeof rawMaxPoints === 'number' ? String(rawMaxPoints) : rawMaxPoints;
  const maxPoints = typeof maxPointsText === 'string' && /^\d+$/.test(maxPointsText)
    ? Number(maxPointsText)
    : NaN;
  if (!Number.isInteger(maxPoints) || maxPoints < MIN_MAX_POINTS || maxPoints > MAX_MAX_POINTS) {
    fields.max_points = 'Must be an integer from 240 to 1200';
  }

  if (Object.keys(fields).length) return validationError(fields);
  return { ok: true, value: { range: rawRange, maxPoints } };
}

function normalizeRows(rows, since, now) {
  return (Array.isArray(rows) ? rows : [])
    .map(row => ({ ...row, ts: numeric(row?.ts) }))
    .filter(row => Number.isInteger(row.ts) && row.ts >= since && row.ts <= now)
    .sort((left, right) => left.ts - right.ts);
}

function sourcePoint(row, previous) {
  let netRx = null;
  let netTx = null;
  let netRxElapsed = null;
  let netTxElapsed = null;

  if (previous && row.ts > previous.ts) {
    const elapsed = row.ts - previous.ts;
    const currentRx = numeric(row.net_rx);
    const previousRx = numeric(previous.net_rx);
    const currentTx = numeric(row.net_tx);
    const previousTx = numeric(previous.net_tx);

    // Counter decreases indicate a restart, interface rollover, or source reset.
    // Keep that timestamp as a gap instead of manufacturing a zero-rate sample.
    if (currentRx !== null && previousRx !== null && currentRx >= previousRx) {
      netRx = (currentRx - previousRx) / elapsed;
      netRxElapsed = elapsed;
    }
    if (currentTx !== null && previousTx !== null && currentTx >= previousTx) {
      netTx = (currentTx - previousTx) / elapsed;
      netTxElapsed = elapsed;
    }
  }

  return {
    ts: row.ts,
    cpu: percentValue(row.cpu),
    ram: percentage(row.ram_used, row.ram_total),
    disk: percentage(row.disk_used, row.disk_total),
    swap: percentage(row.swap_used, row.swap_total),
    net_rx: netRx,
    net_tx: netTx,
    net_rx_elapsed: netRxElapsed,
    net_tx_elapsed: netTxElapsed,
  };
}

function newBucket(ts) {
  return {
    ts,
    stats: Object.fromEntries(SERIES_KEYS.map(key => [key, createStats()])),
  };
}

function aggregatePoints(points, resolutionSeconds) {
  const buckets = new Map();

  for (const point of points) {
    const bucketTs = Math.floor(point.ts / resolutionSeconds) * resolutionSeconds;
    let bucket = buckets.get(bucketTs);
    if (!bucket) {
      bucket = newBucket(bucketTs);
      buckets.set(bucketTs, bucket);
    }
    for (const key of SERIES_KEYS) {
      const weight = key === 'net_rx'
        ? point.net_rx_elapsed
        : key === 'net_tx' ? point.net_tx_elapsed : 1;
      addStats(bucket.stats[key], point[key], weight);
    }
  }

  return [...buckets.values()]
    .sort((left, right) => left.ts - right.ts)
    .map(bucket => ({
      ts: bucket.ts,
      cpu_avg: average(bucket.stats.cpu),
      cpu_max: peak(bucket.stats.cpu),
      ram_avg: average(bucket.stats.ram),
      ram_max: peak(bucket.stats.ram),
      disk_avg: average(bucket.stats.disk),
      disk_max: peak(bucket.stats.disk),
      swap_avg: average(bucket.stats.swap),
      swap_max: peak(bucket.stats.swap),
      net_rx_avg: average(bucket.stats.net_rx),
      net_rx_max: peak(bucket.stats.net_rx),
      net_tx_avg: average(bucket.stats.net_tx),
      net_tx_max: peak(bucket.stats.net_tx),
    }));
}

function thresholdMap(alertConfig) {
  const result = { cpu: null, ram: null, disk: null, swap: null };
  for (const row of Array.isArray(alertConfig) ? alertConfig : []) {
    if (!Object.hasOwn(result, row?.type)) continue;
    result[row.type] = Number(row.enabled) === 0 ? null : numeric(row.threshold);
  }
  return result;
}

function metricSummary(points, key, threshold) {
  const stats = createStats();
  for (const point of points) addStats(stats, point[key]);
  const latest = points.length ? points[points.length - 1][key] : null;
  return {
    current: Number.isFinite(latest) ? round(latest) : null,
    avg: average(stats),
    peak: peak(stats),
    threshold,
    unit: 'percent',
  };
}

function networkSummary(points) {
  const rx = createStats();
  const tx = createStats();
  for (const point of points) {
    addStats(rx, point.net_rx, point.net_rx_elapsed);
    addStats(tx, point.net_tx, point.net_tx_elapsed);
  }
  const latest = points.length ? points[points.length - 1] : null;
  return {
    current: {
      rx: Number.isFinite(latest?.net_rx) ? round(latest.net_rx) : null,
      tx: Number.isFinite(latest?.net_tx) ? round(latest.net_tx) : null,
    },
    avg: { rx: average(rx), tx: average(tx) },
    peak: { rx: peak(rx), tx: peak(tx) },
    threshold: null,
    unit: 'bytes_per_second',
  };
}

function incidentMetric(incident) {
  const explicit = typeof incident?.metric === 'string' ? incident.metric.toLowerCase() : '';
  if (['cpu', 'ram', 'disk', 'swap', 'network'].includes(explicit)) return explicit;
  const type = typeof incident?.type === 'string' ? incident.type.toLowerCase() : '';
  if (!type) return null;
  if (type === 'network' || type.startsWith('net_') || type.includes('network')) return 'network';
  return ['cpu', 'ram', 'disk', 'swap'].find(metric => (
    type === metric || type.startsWith(`${metric}_`) || type.includes(metric)
  )) || null;
}

function normalizeIncidents(incidents, since, now) {
  const rawCounts = { cpu: 0, ram: 0, disk: 0, swap: 0, network: 0 };
  const reportedCounts = { ...rawCounts };
  const normalized = (Array.isArray(incidents) ? incidents : [])
    .map((incident, order) => ({
      id: numeric(incident?.id),
      order,
      ts: numeric(incident?.ts),
      type: typeof incident?.type === 'string' ? incident.type : 'unknown',
      message: typeof incident?.message === 'string' ? incident.message : '',
      value: numeric(incident?.value),
      threshold: numeric(incident?.threshold),
      metric: incidentMetric(incident),
      metricTotal: numeric(incident?.metric_total),
    }))
    .filter(incident => (
      incident.metric
      && Number.isInteger(incident.ts)
      && incident.ts >= since
      && incident.ts <= now
    ));

  for (const incident of normalized) {
    rawCounts[incident.metric] += 1;
    if (Number.isInteger(incident.metricTotal) && incident.metricTotal >= 0) {
      reportedCounts[incident.metric] = Math.max(reportedCounts[incident.metric], incident.metricTotal);
    }
  }

  normalized.sort((left, right) => (
    left.ts - right.ts
    || (left.id ?? left.order) - (right.id ?? right.order)
  ));

  // Keep at least the latest event for every represented metric, then fill the
  // remaining bounded response with the newest incidents across all metrics.
  const latestByMetric = new Map();
  for (const incident of normalized) latestByMetric.set(incident.metric, incident);
  const selected = [...latestByMetric.values()];
  const selectedSet = new Set(selected);
  for (let index = normalized.length - 1; index >= 0 && selected.length < MAX_INCIDENTS; index -= 1) {
    const incident = normalized[index];
    if (selectedSet.has(incident)) continue;
    selected.push(incident);
    selectedSet.add(incident);
  }
  selected.sort((left, right) => (
    left.ts - right.ts
    || (left.id ?? left.order) - (right.id ?? right.order)
  ));

  return {
    counts: Object.fromEntries(Object.keys(rawCounts).map(metric => [
      metric,
      Math.max(rawCounts[metric], reportedCounts[metric]),
    ])),
    items: selected.map(({ id, order, metricTotal, ...incident }) => incident),
  };
}

function buildChartHistory({
  rows = [],
  incidents = [],
  alertConfig = [],
  range = DEFAULT_RANGE,
  maxPoints = DEFAULT_MAX_POINTS,
  now = Math.floor(Date.now() / 1000),
} = {}) {
  const rangeSeconds = RANGE_SECONDS[range];
  if (!rangeSeconds) throw new TypeError(`Unsupported chart range: ${range}`);
  if (!Number.isInteger(maxPoints) || maxPoints < MIN_MAX_POINTS || maxPoints > MAX_MAX_POINTS) {
    throw new TypeError('maxPoints must be an integer from 240 to 1200');
  }

  const generatedAt = Math.floor(Number(now));
  const since = generatedAt - rangeSeconds;
  const resolutionSeconds = chooseResolution(rangeSeconds, maxPoints);
  const normalizedRows = normalizeRows(rows, since, generatedAt);
  const points = [];
  let previous = null;
  for (const row of normalizedRows) {
    points.push(sourcePoint(row, previous));
    previous = row;
  }

  const samples = aggregatePoints(points, resolutionSeconds);
  if (samples.length > maxPoints) {
    throw new RangeError('Chart aggregation exceeded maxPoints');
  }

  const thresholds = thresholdMap(alertConfig);
  const normalizedIncidents = normalizeIncidents(incidents, since, generatedAt);
  return {
    schema: 'charts-history.v2',
    schema_version: 2,
    range,
    max_points: maxPoints,
    resolution_seconds: resolutionSeconds,
    generated_at: generatedAt,
    latest_sample_at: normalizedRows.length ? normalizedRows[normalizedRows.length - 1].ts : null,
    source_count: normalizedRows.length,
    samples,
    summaries: {
      cpu: metricSummary(points, 'cpu', thresholds.cpu),
      ram: metricSummary(points, 'ram', thresholds.ram),
      disk: metricSummary(points, 'disk', thresholds.disk),
      swap: metricSummary(points, 'swap', thresholds.swap),
      network: networkSummary(points),
    },
    incident_counts: normalizedIncidents.counts,
    incidents: normalizedIncidents.items,
  };
}

module.exports = {
  DEFAULT_MAX_POINTS,
  DEFAULT_RANGE,
  MAX_INCIDENTS,
  MAX_MAX_POINTS,
  MIN_MAX_POINTS,
  NICE_BUCKET_SECONDS,
  RANGE_SECONDS,
  buildChartHistory,
  chooseResolution,
  validateChartHistoryQuery,
};
