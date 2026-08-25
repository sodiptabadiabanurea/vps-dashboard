'use strict';

const DEFAULT_THRESHOLDS = Object.freeze({
  cpu: { attention: 75, incident: 90 },
  ram: { attention: 80, incident: 90 },
  swap: { attention: 30, incident: 60 },
  disk: { attention: 80, incident: 90 },
});

const CRITICAL_SERVICES = new Set(['ssh', 'fail2ban', 'nginx']);
const SOURCE_STALE_AFTER_MS = Object.freeze({
  metrics: 15000,
  processes: 20000,
  services: 30000,
  disk: 30000,
});
const DEFAULT_STATE_DWELL_MS = Object.freeze({
  healthy: 6000,
  attention: 4000,
  incident: 4000,
  offline: 4000,
});
const ATTENTION_THRESHOLD_OFFSETS = Object.freeze({
  cpu: 15,
  ram: 10,
  swap: 20,
  disk: 10,
});

function buildThresholdPolicy(rows = []) {
  const policy = Object.fromEntries(
    Object.entries(DEFAULT_THRESHOLDS).map(([key, value]) => [key, { ...value }])
  );
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = safeText(row?.type, 20);
    if (!policy[key]) continue;
    const rawIncident = finite(row?.threshold, NaN);
    if (!Number.isFinite(rawIncident)) continue;
    const incident = Math.min(100, Math.max(1, rawIncident));
    policy[key] = {
      incident,
      attention: Math.max(0, incident - ATTENTION_THRESHOLD_OFFSETS[key]),
    };
  }
  return policy;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(finite(value) * factor) / factor;
}

function safeText(value, maxLength = 240) {
  return String(value == null ? '' : value).slice(0, maxLength);
}

function summarizeProcess(process, extra = {}) {
  return {
    pid: finite(process?.pid),
    name: safeText(process?.name || 'unknown', 120),
    cpu: round(process?.cpu),
    mem: round(process?.mem),
    rss: finite(process?.rss),
    state: safeText(process?.state || 'Unknown', 40),
    ...extra,
  };
}

function buildProcessDiff(previous = [], current = [], now = Date.now()) {
  const previousRows = Array.isArray(previous) ? previous : [];
  const currentRows = Array.isArray(current) ? current : [];
  const baseline = previousRows.length === 0;
  const previousByPid = new Map(previousRows.map(row => [finite(row.pid), row]));
  const currentByPid = new Map(currentRows.map(row => [finite(row.pid), row]));

  if (baseline) {
    return {
      observed_at: now,
      scope: 'top-process-sample',
      baseline: true,
      counts: { entered: 0, left: 0, cpu_spikes: 0, memory_spikes: 0 },
      entered: [],
      left: [],
      cpu_spikes: [],
      memory_spikes: [],
    };
  }

  const enteredAll = currentRows
    .filter(row => {
      const previousRow = previousByPid.get(finite(row.pid));
      return !previousRow || previousRow.name !== row.name;
    })
    .map(row => summarizeProcess(row));

  const leftAll = previousRows
    .filter(row => {
      const currentRow = currentByPid.get(finite(row.pid));
      return !currentRow || currentRow.name !== row.name;
    })
    .map(row => summarizeProcess(row));

  const cpuSpikesAll = currentRows
    .map(row => {
      const previousRow = previousByPid.get(finite(row.pid));
      if (!previousRow || previousRow.name !== row.name) return null;
      const delta = round(finite(row.cpu) - finite(previousRow.cpu));
      if (delta < 10 || finite(row.cpu) < 10) return null;
      return summarizeProcess(row, { delta_cpu: delta, previous_cpu: round(previousRow.cpu) });
    })
    .filter(Boolean)
    .sort((a, b) => b.delta_cpu - a.delta_cpu);

  const memorySpikesAll = currentRows
    .map(row => {
      const previousRow = previousByPid.get(finite(row.pid));
      if (!previousRow || previousRow.name !== row.name) return null;
      const deltaRss = finite(row.rss) - finite(previousRow.rss);
      const deltaMem = round(finite(row.mem) - finite(previousRow.mem));
      if (deltaRss < 128 * 1024 * 1024 && deltaMem < 0.5) return null;
      return summarizeProcess(row, {
        delta_rss: deltaRss,
        delta_mem: deltaMem,
        previous_rss: finite(previousRow.rss),
      });
    })
    .filter(Boolean)
    .sort((a, b) => b.delta_rss - a.delta_rss);

  return {
    observed_at: now,
    scope: 'top-process-sample',
    baseline: false,
    counts: {
      entered: enteredAll.length,
      left: leftAll.length,
      cpu_spikes: cpuSpikesAll.length,
      memory_spikes: memorySpikesAll.length,
    },
    entered: enteredAll.slice(0, 6),
    left: leftAll.slice(0, 6),
    cpu_spikes: cpuSpikesAll.slice(0, 6),
    memory_spikes: memorySpikesAll.slice(0, 6),
  };
}

function getRootDisk(disk = {}) {
  const filesystems = Array.isArray(disk.filesystems) ? disk.filesystems : [];
  return filesystems.find(row => row.mount === '/') || null;
}

function sourceHealth(observedAt, present, staleAfterMs, now) {
  const timestamp = finite(observedAt, 0);
  if (!present) {
    return {
      state: 'missing',
      observed_at: timestamp > 0 ? timestamp : null,
      age_ms: timestamp > 0 ? Math.max(0, now - timestamp) : null,
      stale_after_ms: staleAfterMs,
    };
  }
  if (timestamp > 0) {
    const ageMs = Math.max(0, now - timestamp);
    return {
      state: ageMs > staleAfterMs ? 'stale' : 'fresh',
      observed_at: timestamp,
      age_ms: ageMs,
      stale_after_ms: staleAfterMs,
    };
  }
  return {
    state: 'fresh',
    observed_at: null,
    age_ms: null,
    stale_after_ms: staleAfterMs,
  };
}

function metricSignal(key, label, value, thresholds, recommendation, priority = 60) {
  if (!Number.isFinite(value)) return null;
  if (value >= thresholds.incident) {
    return {
      key,
      label,
      severity: 'incident',
      value: round(value),
      threshold: thresholds.incident,
      summary: `${label} is at ${round(value)}%`,
      recommendation,
      priority,
    };
  }
  if (value >= thresholds.attention) {
    return {
      key,
      label,
      severity: 'attention',
      value: round(value),
      threshold: thresholds.attention,
      summary: `${label} is trending hot at ${round(value)}%`,
      recommendation,
      priority,
    };
  }
  return null;
}

function evaluateMissionState({
  metrics = {},
  services = {},
  disk = {},
  processDiff = {},
  sourceTimestamps = {},
  now = Date.now(),
  thresholds = DEFAULT_THRESHOLDS,
} = {}) {
  const metricTimestamp = finite(metrics.ts, 0);
  const telemetryAge = metricTimestamp > 0 ? Math.max(0, now - metricTimestamp) : null;
  const rootDisk = getRootDisk(disk);
  const hasExplicitProcessSource = Object.prototype.hasOwnProperty.call(sourceTimestamps, 'processes');
  const hasCriticalServiceSnapshot = [...CRITICAL_SERVICES]
    .every(name => services?.[name] && typeof services[name].active === 'boolean');
  const sourceStatus = {
    metrics: sourceHealth(sourceTimestamps.metrics || metricTimestamp, metricTimestamp > 0, SOURCE_STALE_AFTER_MS.metrics, now),
    processes: sourceHealth(
      sourceTimestamps.processes,
      hasExplicitProcessSource ? finite(sourceTimestamps.processes, 0) > 0 : finite(processDiff.observed_at, 0) > 0,
      SOURCE_STALE_AFTER_MS.processes,
      now
    ),
    services: sourceHealth(sourceTimestamps.services, hasCriticalServiceSnapshot, SOURCE_STALE_AFTER_MS.services, now),
    disk: sourceHealth(sourceTimestamps.disk, Boolean(rootDisk), SOURCE_STALE_AFTER_MS.disk, now),
  };
  const unavailableSources = Object.entries(sourceStatus)
    .filter(([, value]) => value.state !== 'fresh')
    .map(([name]) => name);
  const metricValues = {
    cpu: sourceStatus.metrics.state === 'fresh' && Number.isFinite(Number(metrics.cpu)) ? finite(metrics.cpu) : null,
    ram: sourceStatus.metrics.state === 'fresh' && Number.isFinite(Number(metrics.ram_percent)) ? finite(metrics.ram_percent) : null,
    swap: sourceStatus.metrics.state === 'fresh' && Number.isFinite(Number(metrics.swap_percent)) ? finite(metrics.swap_percent) : null,
    disk: sourceStatus.disk.state === 'fresh' && rootDisk ? finite(rootDisk.percent) : null,
  };

  if (telemetryAge == null || telemetryAge > 15000) {
    return {
      level: 'offline',
      status_label: 'Offline',
      weather: 'Signal lost',
      headline: 'Telemetry is stale',
      summary: telemetryAge == null
        ? 'Waiting for the first metrics snapshot.'
        : `Last metrics arrived ${Math.round(telemetryAge / 1000)} seconds ago.`,
      recommendation: 'Check the collector and Socket.IO connection before trusting the displayed values.',
      primary_signal: { key: 'telemetry', label: 'Telemetry', severity: 'incident' },
      signals: [],
      telemetry_age_ms: telemetryAge,
      metrics: metricValues,
      inactive_services: [],
      source_status: sourceStatus,
      unavailable_sources: unavailableSources,
    };
  }

  const signals = [
    metricSignal('cpu', 'CPU', metricValues.cpu, thresholds.cpu, 'Open Process Diff and Charts to identify the workload driving the spike.', 64),
    metricSignal('ram', 'RAM', metricValues.ram, thresholds.ram, 'Review the highest-memory processes and recent deploys.', 68),
    metricSignal('swap', 'Swap', metricValues.swap, thresholds.swap, 'Check memory pressure before swap latency affects services.', 62),
    metricSignal('disk', 'Disk', metricValues.disk, thresholds.disk, 'Review disk growth and the largest directories before capacity becomes critical.', 72),
  ].filter(Boolean);

  const lastKnownInactiveServices = Object.entries(services || {})
    .filter(([name, value]) => name !== '_extra' && CRITICAL_SERVICES.has(name) && value && value.active === false)
    .map(([name]) => name);
  const inactiveServices = sourceStatus.services.state === 'fresh' ? lastKnownInactiveServices : [];

  if (inactiveServices.length > 0) {
    signals.push({
      key: 'services',
      label: 'Core services',
      severity: 'incident',
      value: inactiveServices.length,
      summary: `${inactiveServices.join(', ')} ${inactiveServices.length === 1 ? 'is' : 'are'} inactive`,
      recommendation: 'Open Services and Logs, verify impact, then use the normal confirmed restart flow if required.',
      priority: 100,
    });
  }

  if (unavailableSources.length > 0) {
    const labels = unavailableSources.map(name => name === 'processes' ? 'process' : name);
    signals.push({
      key: 'telemetry',
      label: 'Telemetry coverage',
      severity: 'attention',
      value: unavailableSources.length,
      summary: `${labels.join(', ')} ${labels.length === 1 ? 'telemetry is' : 'telemetry are'} incomplete`,
      recommendation: 'Wait for fresh collector samples before treating the operational picture as complete.',
      priority: 90,
    });
  }

  const topCpuSpike = sourceStatus.processes.state === 'fresh' && Array.isArray(processDiff.cpu_spikes)
    ? processDiff.cpu_spikes[0]
    : null;
  if (topCpuSpike && finite(topCpuSpike.delta_cpu) >= 20) {
    signals.push({
      key: 'processes',
      label: 'Process change',
      severity: metricValues.cpu >= thresholds.cpu.incident ? 'incident' : 'attention',
      value: finite(topCpuSpike.cpu),
      summary: `${safeText(topCpuSpike.name, 80)} jumped +${round(topCpuSpike.delta_cpu)} CPU points`,
      recommendation: 'Open Process Diff to compare the latest top-process snapshots.',
      priority: 50,
    });
  }

  const rank = { attention: 1, incident: 2 };
  signals.sort((a, b) => {
    const severityDelta = (rank[b.severity] || 0) - (rank[a.severity] || 0);
    return severityDelta || finite(b.priority) - finite(a.priority);
  });
  const primary = signals[0] || null;

  if (!primary) {
    return {
      level: 'healthy',
      status_label: 'Healthy',
      weather: 'Clear',
      headline: 'All core systems nominal',
      summary: 'No material pressure or critical service outage is visible in the latest snapshot.',
      recommendation: 'No action required. Keep watching trend and freshness.',
      primary_signal: null,
      signals: [],
      telemetry_age_ms: telemetryAge,
      metrics: metricValues,
      inactive_services: inactiveServices,
      source_status: sourceStatus,
      unavailable_sources: unavailableSources,
      last_known_inactive_services: lastKnownInactiveServices,
    };
  }

  const level = primary.severity === 'incident' ? 'incident' : 'attention';
  return {
    level,
    status_label: level === 'incident' ? 'Incident' : 'Attention',
    weather: level === 'incident' ? 'Storm watch' : 'Windy',
    headline: primary.summary,
    summary: signals.length > 1
      ? `${signals.length} signals need attention; ${primary.label} is the strongest.`
      : `${primary.label} is the only material signal in the current snapshot.`,
    recommendation: primary.recommendation,
    primary_signal: primary,
    signals,
    telemetry_age_ms: telemetryAge,
    metrics: metricValues,
    inactive_services: inactiveServices,
    source_status: sourceStatus,
    unavailable_sources: unavailableSources,
    last_known_inactive_services: lastKnownInactiveServices,
  };
}

function stabilizeMissionState(runtime, candidate, now = Date.now(), dwellMs = DEFAULT_STATE_DWELL_MS) {
  if (!runtime || !candidate) return candidate;

  if (!runtime.stableState || !runtime.level) {
    runtime.level = candidate.level;
    runtime.since = now;
    runtime.stableState = candidate;
    runtime.candidateLevel = null;
    runtime.candidateSince = 0;
    return candidate;
  }

  if (candidate.level === runtime.level) {
    runtime.stableState = candidate;
    runtime.candidateLevel = null;
    runtime.candidateSince = 0;
    return candidate;
  }

  if (runtime.candidateLevel !== candidate.level) {
    runtime.candidateLevel = candidate.level;
    runtime.candidateSince = now;
  }

  const requiredDwell = Math.max(0, finite(dwellMs[candidate.level], 0));
  if (now - runtime.candidateSince >= requiredDwell) {
    runtime.level = candidate.level;
    runtime.since = now;
    runtime.stableState = candidate;
    runtime.candidateLevel = null;
    runtime.candidateSince = 0;
    return candidate;
  }

  return {
    ...runtime.stableState,
    metrics: candidate.metrics,
    telemetry_age_ms: candidate.telemetry_age_ms,
    source_status: candidate.source_status,
    unavailable_sources: candidate.unavailable_sources,
    transition_pending: {
      level: candidate.level,
      since: runtime.candidateSince,
      dwell_ms: requiredDwell,
    },
  };
}

function average(rows, valueFn) {
  const values = rows.map(valueFn).filter(Number.isFinite);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function explanationFor(metric, context) {
  const { state, metrics, processes, disk, history } = context;
  const thresholds = context.thresholds || DEFAULT_THRESHOLDS;
  const nowSeconds = Math.floor(context.now / 1000);
  const recentRows = history.filter(row => finite(row.ts) >= nowSeconds - 15 * 60);
  const topCpu = [...processes].sort((a, b) => finite(b.cpu) - finite(a.cpu)).slice(0, 3).map(summarizeProcess);
  const topMemory = [...processes].sort((a, b) => finite(b.mem) - finite(a.mem)).slice(0, 3).map(summarizeProcess);
  const rootDisk = getRootDisk(disk);
  const topDirectory = Array.isArray(disk.topDirs) ? disk.topDirs[0] : null;
  const sourceStatus = state.source_status || {};

  if (metric === 'telemetry') {
    const unavailable = Array.isArray(state.unavailable_sources) ? state.unavailable_sources : [];
    const evidence = Object.entries(sourceStatus).map(([name, value]) => ({
      label: `${name === 'processes' ? 'Process' : name.charAt(0).toUpperCase() + name.slice(1)} source`,
      value: value?.state === 'fresh'
        ? 'Fresh'
        : value?.state === 'stale' && Number.isFinite(value.age_ms)
          ? `Stale (${Math.round(value.age_ms / 1000)}s)`
          : 'Unavailable',
      tone: value?.state === 'fresh' ? 'normal' : 'attention',
    }));
    return {
      title: 'Why is telemetry incomplete?',
      summary: unavailable.length
        ? `${unavailable.join(', ')} ${unavailable.length === 1 ? 'source is' : 'sources are'} not fresh enough for a complete operational picture.`
        : 'All Mission Control sources are fresh.',
      confidence: null,
      coverage_label: unavailable.length ? 'Evidence coverage is partial' : 'All evidence sources are fresh',
      evidence,
      next_checks: [
        { label: 'Open Logs', page: 'logs' },
        { label: 'Open Dashboard', page: 'dashboard' },
      ],
    };
  }

  if (metric === 'cpu') {
    const baseline = average(recentRows, row => finite(row.cpu));
    const current = finite(metrics.cpu);
    const metricsFresh = sourceStatus.metrics?.state === 'fresh';
    const processesFresh = sourceStatus.processes?.state === 'fresh';
    return {
      title: 'Why is CPU here?',
      summary: !metricsFresh
        ? 'The metrics snapshot is missing or stale, so current CPU pressure is unknown.'
        : !processesFresh
          ? 'CPU is current, but the process sample is not fresh enough to attribute visible workload.'
          : topCpu.length
        ? `${topCpu[0].name} is the largest visible CPU consumer in the top-process sample.`
        : 'No process snapshot is available yet.',
      confidence: null,
      coverage_label: !metricsFresh
        ? 'CPU evidence is not fresh'
        : !processesFresh
          ? 'Current CPU; process evidence is stale'
          : baseline == null ? 'Current CPU and process sample' : 'Current CPU, 15m trend, and process sample',
      evidence: [
        { label: metricsFresh ? 'Current CPU' : 'Last known CPU', value: Number.isFinite(Number(metrics.cpu)) ? `${round(current)}%` : 'Unknown', tone: !metricsFresh ? 'attention' : current >= thresholds.cpu.incident ? 'incident' : current >= thresholds.cpu.attention ? 'attention' : 'normal' },
        { label: '15 min baseline', value: baseline == null ? 'Collecting' : `${round(baseline)}%`, tone: 'neutral' },
        ...topCpu.map(process => ({ label: processesFresh ? process.name : `Last known ${process.name}`, value: `${process.cpu}% CPU`, tone: processesFresh ? 'neutral' : 'attention' })),
      ],
      next_checks: [
        { label: 'Open Processes', page: 'processes' },
        { label: 'Open Charts', page: 'charts' },
        { label: 'Open Logs', page: 'logs' },
      ],
    };
  }

  if (metric === 'ram') {
    const baseline = average(recentRows, row => finite(row.ram_total) > 0 ? (finite(row.ram_used) / finite(row.ram_total)) * 100 : NaN);
    const current = finite(metrics.ram_percent);
    const metricsFresh = sourceStatus.metrics?.state === 'fresh';
    const processesFresh = sourceStatus.processes?.state === 'fresh';
    return {
      title: 'Why is RAM here?',
      summary: !metricsFresh
        ? 'The metrics snapshot is missing or stale, so current memory pressure is unknown.'
        : !processesFresh
          ? 'RAM is current, but the process sample is not fresh enough to rank memory consumers.'
          : topMemory.length
        ? `${topMemory[0].name} has the largest visible memory share in the current top-process sample.`
        : 'No process memory snapshot is available yet.',
      confidence: null,
      coverage_label: !metricsFresh
        ? 'RAM evidence is not fresh'
        : !processesFresh
          ? 'Current RAM; process evidence is stale'
          : baseline == null ? 'Current RAM and process sample' : 'Current RAM, 15m trend, and process sample',
      evidence: [
        { label: metricsFresh ? 'Current RAM' : 'Last known RAM', value: Number.isFinite(Number(metrics.ram_percent)) ? `${round(current)}%` : 'Unknown', tone: !metricsFresh ? 'attention' : current >= thresholds.ram.incident ? 'incident' : current >= thresholds.ram.attention ? 'attention' : 'normal' },
        { label: '15 min baseline', value: baseline == null ? 'Collecting' : `${round(baseline)}%`, tone: 'neutral' },
        ...topMemory.map(process => ({ label: processesFresh ? process.name : `Last known ${process.name}`, value: `${process.mem}% MEM`, tone: processesFresh ? 'neutral' : 'attention' })),
      ],
      next_checks: [
        { label: 'Open Processes', page: 'processes' },
        { label: 'Open Charts', page: 'charts' },
      ],
    };
  }

  if (metric === 'disk') {
    const current = rootDisk ? finite(rootDisk.percent) : 0;
    const diskFresh = sourceStatus.disk?.state === 'fresh';
    return {
      title: 'Why is disk here?',
      summary: !diskFresh
        ? 'The disk snapshot is missing or stale, so current capacity is unknown.'
        : topDirectory
        ? `${safeText(topDirectory.path, 120)} is the largest directory in the latest capacity sample.`
        : 'Directory sizing has not completed yet.',
      confidence: null,
      coverage_label: !diskFresh
        ? 'Disk evidence is not fresh'
        : rootDisk && topDirectory ? 'Filesystem and directory evidence available' : 'Disk evidence is still partial',
      evidence: [
        {
          label: diskFresh ? 'Root usage' : 'Last known root usage',
          value: rootDisk ? `${round(current)}%` : 'Unknown',
          tone: !diskFresh ? 'attention' : current >= thresholds.disk.incident ? 'incident' : current >= thresholds.disk.attention ? 'attention' : 'normal',
        },
        {
          label: diskFresh ? 'Largest directory' : 'Last known largest directory',
          value: topDirectory ? `${safeText(topDirectory.path, 80)} (${safeText(topDirectory.size, 24)})` : 'Unknown',
          tone: diskFresh ? 'neutral' : 'attention',
        },
      ],
      next_checks: [
        { label: 'Open Dashboard', page: 'dashboard' },
        { label: 'Open Files', page: 'files' },
      ],
    };
  }

  if (metric === 'services') {
    const inactive = state.inactive_services || [];
    const lastKnownInactive = state.last_known_inactive_services || [];
    const servicesFresh = sourceStatus.services?.state === 'fresh';
    return {
      title: 'Why is service health here?',
      summary: !servicesFresh
        ? 'The service snapshot is missing or stale, so current service health is unknown.'
        : inactive.length
        ? `${inactive.join(', ')} ${inactive.length === 1 ? 'is' : 'are'} inactive.`
        : 'All mission-critical services are active.',
      confidence: null,
      coverage_label: servicesFresh ? 'Critical service state verified' : 'Service evidence is not fresh',
      evidence: [
        {
          label: servicesFresh ? 'Critical inactive' : 'Last known inactive',
          value: servicesFresh
            ? (inactive.length ? inactive.join(', ') : 'None')
            : (lastKnownInactive.length ? lastKnownInactive.join(', ') : 'Unknown'),
          tone: servicesFresh && inactive.length ? 'incident' : servicesFresh ? 'normal' : 'attention',
        },
      ],
      next_checks: [
        { label: 'Open Logs', page: 'logs' },
        { label: 'Open Timeline', page: 'timeline' },
      ],
    };
  }

  return explanationFor('cpu', context);
}

function parseEventMetadata(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function phaseForEvent(event, metadata = {}) {
  const explicit = safeText(event.phase || metadata.phase, 20);
  if (['change', 'trigger', 'impact', 'recovery', 'context'].includes(explicit)) return explicit;
  const text = `${safeText(event.title)} ${safeText(event.detail)}`.toLowerCase();
  if (/recover|restored|resolved|back online|active again/.test(text)) return 'recovery';
  if (event.category === 'deploy' || event.category === 'security') return 'change';
  if (event.category === 'alert') return 'trigger';
  if (event.category === 'service' || event.category === 'uptime') return 'impact';
  return 'context';
}

function enrichTimeline(rows = [], now = Date.now()) {
  return (Array.isArray(rows) ? rows : []).slice(0, 12).map(row => {
    const metadata = parseEventMetadata(row.metadata);
    return {
      id: finite(row.id),
      ts: finite(row.ts),
      type: safeText(row.type, 80),
      category: safeText(row.category, 40),
      title: safeText(row.title, 180),
      detail: safeText(row.detail, 360),
      source: safeText(row.source, 100),
      phase: phaseForEvent(row, metadata),
      relation: safeText(metadata.relation, 40),
      correlation_id: safeText(metadata.correlation_id, 80),
      age_seconds: Math.max(0, Math.floor(now / 1000) - finite(row.ts)),
    };
  });
}

function buildMissionControlSnapshot({
  metrics = {},
  processes = [],
  services = {},
  disk = {},
  processDiff = {},
  history = [],
  timeline = [],
  now = Date.now(),
  revision = 0,
  incidentSince = now,
  sourceTimestamps = {},
  stateOverride = null,
  bootId = '',
  thresholds = DEFAULT_THRESHOLDS,
} = {}) {
  const state = stateOverride || evaluateMissionState({ metrics, services, disk, processDiff, sourceTimestamps, thresholds, now });
  const events = enrichTimeline(timeline, now);
  const recentChange = processDiff.cpu_spikes?.[0]
    ? `${safeText(processDiff.cpu_spikes[0].name, 80)} entered a higher CPU band`
    : processDiff.entered?.[0]
      ? `${safeText(processDiff.entered[0].name, 80)} entered the top-process sample`
      : events[0]?.title || 'No material change detected in the recent sample.';

  const context = { state, metrics, processes, services, disk, processDiff, history, thresholds, now };
  return {
    schema_version: 1,
    boot_id: safeText(bootId, 80),
    revision,
    generated_at: now,
    incident_since: incidentSince,
    thresholds,
    ...state,
    recent_change: recentChange,
    process_diff: processDiff,
    causal_events: events.slice(0, 6),
    explanations: {
      cpu: explanationFor('cpu', context),
      ram: explanationFor('ram', context),
      disk: explanationFor('disk', context),
      services: explanationFor('services', context),
      telemetry: explanationFor('telemetry', context),
    },
  };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  DEFAULT_STATE_DWELL_MS,
  buildThresholdPolicy,
  buildProcessDiff,
  evaluateMissionState,
  stabilizeMissionState,
  buildMissionControlSnapshot,
  enrichTimeline,
};
