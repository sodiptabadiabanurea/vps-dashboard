'use strict';

const dns = require('dns').promises;
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const tls = require('tls');
const {
  ToolInputError,
  commandOutput,
  publicExecution,
  runCommand,
  toolEnvelope,
} = require('./network-tools-core');

const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const DEFAULT_PORTS = [22, 80, 443, 3000, 3306, 5432, 8080, 8443];
const DNS_TYPES = new Set(['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'SOA', 'CAA']);
const TRACE_MODES = new Set(['auto', 'tcp', 'udp']);
const PORT_SERVICES = new Map([
  [22, 'ssh'], [25, 'smtp'], [53, 'dns'], [80, 'http'], [110, 'pop3'], [143, 'imap'],
  [443, 'https'], [465, 'smtps'], [587, 'submission'], [993, 'imaps'], [995, 'pop3s'],
  [3000, 'node'], [3306, 'mysql'], [5432, 'postgres'], [6379, 'redis'], [8080, 'http-alt'], [8443, 'https-alt'],
]);

class ToolServiceError extends Error {
  constructor(code, message, statusCode = 503) {
    super(message);
    this.name = 'ToolServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function findExecutable(candidates, searchPath = process.env.PATH || DEFAULT_PATH) {
  const dirs = searchPath.split(':').filter(Boolean);
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

function boundedInteger(value, fallback, min, max, code = 'INVALID_PARAMETER') {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ToolInputError(code, `Value must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function normalizeRecordType(value) {
  const type = String(value || 'A').trim().toUpperCase();
  if (!DNS_TYPES.has(type)) throw new ToolInputError('INVALID_RECORD_TYPE', 'Unsupported DNS record type.');
  return type;
}

function normalizeTraceMode(value) {
  const mode = String(value || 'auto').trim().toLowerCase();
  if (!TRACE_MODES.has(mode)) throw new ToolInputError('INVALID_TRACE_MODE', 'Trace mode must be auto, tcp, or udp.');
  return mode;
}

function parsePortSpec(value, options = {}) {
  const maxPorts = Math.max(1, Number(options.maxPorts) || 32);
  const raw = String(value == null || value === '' ? DEFAULT_PORTS.join(',') : value).trim();
  if (!raw) throw new ToolInputError('INVALID_PORTS', 'Enter at least one TCP port.');
  if (raw.length > 512) throw new ToolInputError('INVALID_PORTS', 'Port specification is too long.');
  const ports = [];
  const seen = new Set();

  for (const token of raw.split(',').map(item => item.trim()).filter(Boolean)) {
    const range = token.match(/^(\d+)-(\d+)$/);
    const single = token.match(/^\d+$/);
    if (!range && !single) throw new ToolInputError('INVALID_PORTS', `Invalid port token: ${token}`);
    const start = Number(range ? range[1] : token);
    const end = Number(range ? range[2] : token);
    if (start < 1 || end > 65535 || start > end) throw new ToolInputError('INVALID_PORTS', `Port range is invalid: ${token}`);
    if (end - start + 1 > maxPorts) throw new ToolInputError('PORT_LIMIT_EXCEEDED', `A single range cannot exceed ${maxPorts} ports.`);
    for (let port = start; port <= end; port += 1) {
      if (seen.has(port)) continue;
      seen.add(port);
      ports.push(port);
      if (ports.length > maxPorts) throw new ToolInputError('PORT_LIMIT_EXCEEDED', `Scan is limited to ${maxPorts} unique ports.`);
    }
  }
  return ports;
}

function raceWithAbort(promise, signal, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      const error = new Error('Diagnostic cancelled.');
      error.code = 'ABORT_ERR';
      finish(reject, error);
    };
    const timer = setTimeout(() => {
      const error = new Error('Name resolution timed out.');
      error.code = 'ETIMEOUT';
      finish(reject, error);
    }, timeoutMs);
    timer.unref?.();
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(value => finish(resolve, value), error => finish(reject, error));
  });
}

async function resolveTargetAddresses(target, options = {}) {
  if (target.family) {
    return { addresses: [{ address: target.host, family: target.family, scope: target.scope }], error: null };
  }
  const lookup = options.lookup || dns.lookup;
  try {
    const rows = await raceWithAbort(
      lookup(target.host, { all: true, verbatim: true }),
      options.signal,
      options.timeoutMs || 3000
    );
    const seen = new Set();
    const addresses = [];
    for (const row of rows || []) {
      const key = `${row.family}:${row.address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      addresses.push({ address: row.address, family: row.family });
    }
    return { addresses, error: addresses.length ? null : { code: 'ENODATA', message: 'No address records found.' } };
  } catch (error) {
    if (error.code === 'ABORT_ERR') throw error;
    return { addresses: [], error: { code: error.code || 'RESOLUTION_FAILED', message: error.message } };
  }
}

function preferredAddress(addresses, target) {
  if (target.family) return addresses[0] || null;
  return addresses.find(row => row.family === 4) || addresses[0] || null;
}

function resolutionFailureDiagnosis(error) {
  const code = error?.code || 'RESOLUTION_FAILED';
  const mapping = {
    ENOTFOUND: ['TARGET_NOT_FOUND', 'error', 'Hostname does not exist.'],
    ENODATA: ['NO_ADDRESS_RECORDS', 'warning', 'Hostname has no usable IPv4 or IPv6 address records.'],
    ETIMEOUT: ['DNS_TIMEOUT', 'error', 'Target resolution timed out.'],
    EAI_AGAIN: ['DNS_TEMPORARY_FAILURE', 'error', 'Target resolution failed temporarily; try again shortly.'],
    ESERVFAIL: ['DNS_SERVFAIL', 'error', 'The DNS resolver reported a server failure.'],
    EREFUSED: ['DNS_REFUSED', 'error', 'The DNS resolver refused the address lookup.'],
  };
  const [diagnosisCode, severity, summary] = mapping[code] || ['RESOLUTION_FAILED', 'error', 'Target resolution failed for an unknown resolver error.'];
  return { code: diagnosisCode, severity, summary };
}

function parsePingOutput(output) {
  const summary = output.match(/(\d+) packets transmitted,\s*(\d+) received,\s*([\d.]+)% packet loss/i);
  const latency = output.match(/(?:rtt|round-trip)[^=]*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)\s*ms/i);
  return {
    sent: summary ? Number(summary[1]) : null,
    received: summary ? Number(summary[2]) : null,
    packet_loss_percent: summary ? Number(summary[3]) : null,
    latency_ms: latency ? {
      min: Number(latency[1]),
      avg: Number(latency[2]),
      max: Number(latency[3]),
      mdev: Number(latency[4]),
    } : null,
  };
}

async function runPingDiagnostic(target, options = {}) {
  const startedAt = Date.now();
  const count = boundedInteger(options.count, 3, 1, 5, 'INVALID_PING_COUNT');
  const replyTimeout = boundedInteger(options.replyTimeout, 1, 1, 3, 'INVALID_PING_TIMEOUT');
  const resolution = options.resolution || await resolveTargetAddresses(target, { signal: options.signal, lookup: options.lookup });
  const selected = preferredAddress(resolution.addresses, target);
  if (!selected) {
    const diagnosis = resolutionFailureDiagnosis(resolution.error);
    return toolEnvelope({
      requestId: options.requestId,
      tool: 'ping',
      ok: true,
      target,
      status: diagnosis.code === 'DNS_TIMEOUT' ? 'timed_out' : 'complete',
      diagnosis,
      durationMs: Date.now() - startedAt,
      timedOut: diagnosis.code === 'DNS_TIMEOUT',
      warnings: target.warnings,
      data: { host: target.host, resolved_addresses: [], ping: { sent: 0, received: 0, packet_loss_percent: null, latency_ms: null } },
    });
  }

  const pingPath = options.pingPath || findExecutable(['ping']);
  if (!pingPath) throw new ToolServiceError('TOOL_UNAVAILABLE', 'Ping command is not installed.');
  const commandTimeoutMs = Math.min(7000, Math.max(2000, ((count - 1) * 200) + (replyTimeout * 1000) + 1000));
  const args = [
    '-n', selected.family === 6 ? '-6' : '-4',
    '-c', String(count),
    '-W', String(replyTimeout),
    '-i', '0.2',
    '--', selected.address,
  ];
  const runner = options.runner || runCommand;
  const result = await runner(pingPath, args, {
    timeoutMs: commandTimeoutMs,
    signal: options.signal,
  });
  if (result.aborted) return null;

  const output = commandOutput(result);
  const ping = parsePingOutput(output);
  let diagnosis;
  if ((ping.received || 0) > 0) {
    diagnosis = { code: 'REACHABLE', severity: 'healthy', summary: `Target replied to ${ping.received}/${ping.sent} ICMP probe(s).` };
  } else if (/network is unreachable/i.test(output)) {
    diagnosis = { code: 'NETWORK_UNREACHABLE', severity: 'error', summary: 'The VPS has no route to this target.' };
  } else if (result.timedOut) {
    diagnosis = { code: 'PING_TIMEOUT', severity: 'warning', summary: 'Ping exceeded its time budget without a reply.' };
  } else {
    diagnosis = { code: 'NO_ICMP_REPLY', severity: 'warning', summary: 'No ICMP reply. The target may still be reachable over TCP or HTTP.' };
  }

  return toolEnvelope({
    requestId: options.requestId,
    tool: 'ping',
    ok: true,
    status: result.timedOut ? 'timed_out' : 'complete',
    target,
    diagnosis,
    durationMs: Date.now() - startedAt,
    execution: publicExecution(result, 'ping'),
    output,
    warnings: target.warnings,
    data: {
      host: target.host,
      resolved_addresses: resolution.addresses,
      selected_address: selected,
      ping,
    },
  });
}

function parseTraceOutput(output, selectedAddress) {
  const hops = [];
  for (const rawLine of String(output || '').split('\n')) {
    const line = rawLine.trimEnd();
    let match = line.match(/^\s*(\d+)[?:]?\s*:\s*(.+)$/);
    if (match) {
      const detail = match[2].trim();
      const latency = detail.match(/([\d.]+)ms/i);
      const token = detail.match(/(?:\[LOCALHOST\]|no reply|([0-9a-f:.]+))/i);
      hops.push({
        hop: Number(match[1]),
        address: token?.[1] || null,
        state: /no reply/i.test(detail) ? 'no_reply' : /\[LOCALHOST\]/i.test(detail) ? 'local' : 'reply',
        latency_ms: latency ? Number(latency[1]) : null,
        detail,
      });
      continue;
    }
    match = line.match(/^\s*(\d+)\s+(\S+)(?:\s+([\d.]+)\s*ms)?/i);
    if (match) {
      hops.push({ hop: Number(match[1]), address: match[2] === '*' ? null : match[2], state: match[2] === '*' ? 'no_reply' : 'reply', latency_ms: match[3] ? Number(match[3]) : null, detail: line.trim() });
    }
  }
  const reached = /\breached\b/i.test(output) || hops.some(hop => hop.address === selectedAddress && hop.state === 'reply');
  return { reached_target: reached, hops };
}

function finiteMetric(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseMtrJson(output, selectedAddress) {
  let report;
  try {
    report = JSON.parse(String(output || '').trim());
  } catch (_) {
    return { valid: false, reached_target: false, hops: [] };
  }

  const hubs = report?.report?.hubs;
  if (!Array.isArray(hubs)) return { valid: false, reached_target: false, hops: [] };

  const hops = hubs.map((hub, index) => {
    const host = String(hub?.host || '').trim();
    const lossPercent = finiteMetric(hub?.['Loss%']);
    const latency = finiteMetric(hub?.Last) ?? finiteMetric(hub?.Avg);
    const replied = Boolean(host && host !== '???' && (lossPercent == null || lossPercent < 100));
    return {
      hop: Number.isInteger(Number(hub?.count)) ? Number(hub.count) : index + 1,
      address: replied ? host : null,
      state: replied ? 'reply' : 'no_reply',
      latency_ms: latency,
      loss_percent: lossPercent,
      sent: finiteMetric(hub?.Snt),
      avg_ms: finiteMetric(hub?.Avg),
      best_ms: finiteMetric(hub?.Best),
      worst_ms: finiteMetric(hub?.Wrst),
      stdev_ms: finiteMetric(hub?.StDev),
      detail: replied ? host : 'no reply',
    };
  });
  const reached = hops.some(hop => hop.address === selectedAddress && hop.state === 'reply');
  return { valid: true, reached_target: reached, hops };
}

function formatMtrTraceOutput(trace) {
  if (!trace.hops.length) return 'No hop responses were reported.';
  return trace.hops.map(hop => {
    if (hop.state === 'no_reply') {
      return `${hop.hop}  *  no reply${hop.loss_percent != null ? `  loss=${hop.loss_percent}%` : ''}`;
    }
    const metrics = [];
    if (hop.latency_ms != null) metrics.push(`${hop.latency_ms} ms`);
    if (hop.loss_percent != null) metrics.push(`loss=${hop.loss_percent}%`);
    return `${hop.hop}  ${hop.address}${metrics.length ? `  ${metrics.join('  ')}` : ''}`;
  }).join('\n');
}

function traceProviderPaths(options = {}) {
  if (options.tracerPath) {
    const provider = path.basename(options.tracerPath);
    return {
      mtr: provider === 'mtr' ? options.tracerPath : null,
      traceroute: provider === 'traceroute' ? options.tracerPath : null,
      tracepath: provider === 'tracepath' ? options.tracerPath : null,
    };
  }

  const has = key => Object.prototype.hasOwnProperty.call(options, key);
  return {
    mtr: has('mtrPath') ? options.mtrPath : findExecutable(['mtr']),
    traceroute: has('traceroutePath') ? options.traceroutePath : findExecutable(['traceroute']),
    tracepath: has('tracepathPath') ? options.tracepathPath : findExecutable(['tracepath']),
  };
}

function buildTracePlans(paths, requestedMode, maxHops, address) {
  const timeoutMs = maxHops <= 12 ? 12000 : 20000;
  const familyFlag = net.isIP(address) === 6 ? '-6' : '-4';
  const plans = [];
  if (requestedMode === 'auto' || requestedMode === 'tcp') {
    if (paths.mtr) {
      plans.push({
        command: paths.mtr,
        provider: 'mtr',
        mode: 'tcp',
        port: 443,
        args: [familyFlag, '-T', '-P', '443', '-n', '-r', '-j', '-c', '1', '-m', String(maxHops), '-G', '1', '-Z', '1', '--', address],
        timeoutMs,
      });
    }
    if (paths.traceroute) {
      plans.push({
        command: paths.traceroute,
        provider: 'traceroute',
        mode: 'tcp',
        port: 443,
        args: ['-n', '-T', '-p', '443', '-q', '1', '-m', String(maxHops), '-w', '1', '--', address],
        timeoutMs,
      });
    }
  }
  if (requestedMode === 'auto' || requestedMode === 'udp') {
    if (paths.traceroute) {
      plans.push({
        command: paths.traceroute,
        provider: 'traceroute',
        mode: 'udp',
        port: null,
        args: ['-n', '-q', '1', '-m', String(maxHops), '-w', '1', '--', address],
        timeoutMs,
      });
    }
    if (paths.tracepath) {
      plans.push({
        command: paths.tracepath,
        provider: 'tracepath',
        mode: 'udp',
        port: null,
        args: ['-n', '-m', String(maxHops), '--', address],
        timeoutMs,
      });
    }
  }
  return plans;
}

function traceAttemptUnavailable(plan, result, parsed, output) {
  if (result.aborted || result.timedOut || parsed.hops.length || parsed.reached_target) return false;
  if (result.errorCode === 'ENOENT') return true;
  if (plan.provider === 'mtr' && !parsed.valid && result.exitCode === 0) return true;
  if (result.exitCode === 0) return false;
  return /(unknown|invalid|unrecognized|illegal) option|usage:|permission denied|operation not permitted|not supported|requires root|(?:fail|unable|cannot).*open.*socket/i.test(output);
}

function traceFallbackWarning(plan) {
  return `TRACE_FALLBACK_${plan.provider.toUpperCase()}_${plan.mode.toUpperCase()}_UNAVAILABLE`;
}

async function runTraceDiagnostic(target, options = {}) {
  const startedAt = Date.now();
  const maxHops = boundedInteger(options.maxHops, 12, 5, 20, 'INVALID_TRACE_HOPS');
  const requestedMode = normalizeTraceMode(options.mode);
  const resolution = options.resolution || await resolveTargetAddresses(target, { signal: options.signal, lookup: options.lookup });
  const selected = preferredAddress(resolution.addresses, target);
  if (!selected) {
    const diagnosis = resolutionFailureDiagnosis(resolution.error);
    return toolEnvelope({
      requestId: options.requestId,
      tool: 'traceroute',
      ok: true,
      target,
      status: diagnosis.code === 'DNS_TIMEOUT' ? 'timed_out' : 'complete',
      diagnosis,
      durationMs: Date.now() - startedAt,
      timedOut: diagnosis.code === 'DNS_TIMEOUT',
      warnings: target.warnings,
      data: {
        host: target.host,
        resolved_addresses: [],
        provider: null,
        requested_mode: requestedMode,
        mode: null,
        transport: null,
        port: null,
        trace_attempts: [],
        trace: { provider: null, mode: null, transport: null, port: null, reached_target: false, hops: [] },
      },
    });
  }

  const plans = buildTracePlans(traceProviderPaths(options), requestedMode, maxHops, selected.address);
  if (!plans.length) {
    const code = requestedMode === 'tcp' ? 'TCP_TRACE_UNAVAILABLE' : 'TOOL_UNAVAILABLE';
    throw new ToolServiceError(code, requestedMode === 'tcp' ? 'No TCP traceroute provider is installed.' : 'No traceroute-compatible command is installed.');
  }

  const runner = options.runner || runCommand;
  const warnings = [...target.warnings];
  const attempts = [];
  let selectedAttempt = null;
  for (const plan of plans) {
    const result = await runner(plan.command, plan.args, { timeoutMs: plan.timeoutMs, signal: options.signal });
    if (result.aborted) return null;
    const rawOutput = commandOutput(result);
    const parsed = plan.provider === 'mtr'
      ? parseMtrJson(result.stdout, selected.address)
      : { valid: true, ...parseTraceOutput(rawOutput, selected.address) };
    attempts.push({
      provider: plan.provider,
      mode: plan.mode,
      transport: plan.mode,
      port: plan.port,
      execution: publicExecution(result, plan.provider),
    });
    if (traceAttemptUnavailable(plan, result, parsed, rawOutput)) {
      warnings.push(traceFallbackWarning(plan));
      continue;
    }
    selectedAttempt = { plan, result, parsed, rawOutput };
    break;
  }

  if (!selectedAttempt) {
    const code = requestedMode === 'tcp' ? 'TCP_TRACE_UNAVAILABLE' : 'TOOL_UNAVAILABLE';
    throw new ToolServiceError(code, 'No usable traceroute provider is available.');
  }

  const { plan, result, parsed, rawOutput } = selectedAttempt;
  const trace = {
    provider: plan.provider,
    mode: plan.mode,
    transport: plan.mode,
    port: plan.port,
    reached_target: parsed.reached_target,
    hops: parsed.hops,
  };
  const output = plan.provider === 'mtr'
    ? parsed.valid
      ? formatMtrTraceOutput(trace)
      : result.stderr || result.error || 'No parseable MTR hop report was produced.'
    : rawOutput;
  const replyHopCount = trace.hops.filter(hop => hop.state === 'reply' || hop.state === 'local').length;
  let diagnosis;
  if (trace.reached_target) {
    diagnosis = { code: 'TRACE_REACHED', severity: 'healthy', summary: `Destination reached in ${Math.max(...trace.hops.map(hop => hop.hop), 0)} hop(s).` };
  } else if (replyHopCount) {
    diagnosis = { code: result.timedOut ? 'TRACE_PARTIAL_TIMEOUT' : 'TRACE_PARTIAL', severity: 'warning', summary: `Collected ${replyHopCount} hop response(s), but the destination was not reached.` };
  } else if (result.timedOut || trace.hops.length) {
    diagnosis = { code: 'TRACE_FILTERED_NO_RESPONSE', severity: 'warning', summary: result.timedOut ? 'No hop replied before the trace deadline; filtering or dropped probes may be involved.' : 'No hop replied to the completed trace; filtering or dropped probes may be involved.' };
  } else {
    diagnosis = { code: 'TRACE_FAILED', severity: 'error', summary: 'Route trace produced no usable hop evidence.' };
  }

  return toolEnvelope({
    requestId: options.requestId,
    tool: 'traceroute',
    ok: true,
    status: trace.reached_target ? 'complete' : replyHopCount ? 'partial' : result.timedOut ? 'timed_out' : trace.hops.length ? 'partial' : 'error',
    target,
    diagnosis,
    durationMs: Date.now() - startedAt,
    execution: publicExecution(result, plan.provider),
    output,
    warnings,
    data: {
      host: target.host,
      provider: plan.provider,
      requested_mode: requestedMode,
      mode: plan.mode,
      transport: plan.mode,
      port: plan.port,
      trace_attempts: attempts,
      resolved_addresses: resolution.addresses,
      selected_address: selected,
      trace,
    },
  });
}

function dnsErrorDiagnosis(error) {
  const code = error?.code || 'DNS_ERROR';
  const mapping = {
    ENOTFOUND: ['NXDOMAIN', 'warning', 'Domain does not exist.'],
    ENODATA: ['NO_DATA', 'neutral', 'Domain exists but has no records of this type.'],
    ESERVFAIL: ['SERVFAIL', 'error', 'DNS resolver reported a server failure.'],
    EREFUSED: ['REFUSED', 'error', 'DNS resolver refused the query.'],
    ETIMEOUT: ['DNS_TIMEOUT', 'error', 'DNS query timed out.'],
    ECANCELLED: ['DNS_CANCELLED', 'warning', 'DNS query was cancelled.'],
  };
  const [diagnosisCode, severity, summary] = mapping[code] || ['DNS_ERROR', 'error', 'DNS lookup failed.'];
  return { code: diagnosisCode, severity, summary };
}

function formatDnsRecords(type, records) {
  if (type === 'A' || type === 'AAAA') return records.map(row => typeof row === 'string' ? row : `${row.address}${row.ttl != null ? ` TTL=${row.ttl}` : ''}`);
  if (type === 'MX') return records.map(row => `${row.priority} ${row.exchange}`);
  if (type === 'TXT') return records.map(row => Array.isArray(row) ? row.join('') : String(row));
  if (type === 'SOA') return records ? [`${records.nsname} ${records.hostmaster} serial=${records.serial} refresh=${records.refresh} retry=${records.retry} expire=${records.expire} minttl=${records.minttl}`] : [];
  if (type === 'CAA') return records.map(row => Object.entries(row).map(([key, value]) => `${key}=${value}`).join(' '));
  return records.map(String);
}

async function runDnsDiagnostic(target, options = {}) {
  const startedAt = Date.now();
  const type = normalizeRecordType(options.recordType);
  const resolver = options.resolver || new dns.Resolver({ timeout: 2000, tries: 1 });
  const methodByType = {
    A: 'resolve4', AAAA: 'resolve6', MX: 'resolveMx', TXT: 'resolveTxt', NS: 'resolveNs',
    CNAME: 'resolveCname', SOA: 'resolveSoa', CAA: 'resolveCaa',
  };
  const method = methodByType[type];
  let records = [];
  let diagnosis;
  try {
    const query = (type === 'A' || type === 'AAAA')
      ? resolver[method](target.host, { ttl: true })
      : resolver[method](target.host);
    const answer = await raceWithAbort(query, options.signal, options.timeoutMs || 3500);
    records = type === 'SOA' ? answer : Array.isArray(answer) ? answer : [];
    const formatted = formatDnsRecords(type, records);
    diagnosis = formatted.length
      ? { code: 'ANSWER', severity: 'healthy', summary: `${formatted.length} ${type} record(s) found.` }
      : { code: 'NO_DATA', severity: 'neutral', summary: 'Domain exists but has no records of this type.' };
  } catch (error) {
    if (error.code === 'ABORT_ERR') return null;
    diagnosis = dnsErrorDiagnosis(error);
  }

  const result = diagnosis.code === 'ANSWER' ? formatDnsRecords(type, records) : [];
  const resolverServers = typeof resolver.getServers === 'function' ? resolver.getServers() : [];
  return toolEnvelope({
    requestId: options.requestId,
    tool: 'dns',
    ok: true,
    status: diagnosis.code === 'DNS_TIMEOUT' ? 'timed_out' : 'complete',
    target,
    diagnosis,
    durationMs: Date.now() - startedAt,
    timedOut: diagnosis.code === 'DNS_TIMEOUT',
    output: result.join('\n'),
    warnings: target.warnings,
    data: {
      host: target.host,
      type,
      result,
      dns: {
        rcode: diagnosis.code,
        answers: records,
        resolver: resolverServers,
      },
    },
  });
}

function checkTcpPort(address, port, options = {}) {
  const timeoutMs = options.timeoutMs || 1200;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let socket = null;
    let settled = false;
    const finish = (status, errorCode = null) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      socket?.destroy();
      resolve({
        port,
        service: PORT_SERVICES.get(port) || null,
        status,
        latency_ms: Date.now() - startedAt,
        error_code: errorCode,
      });
    };
    const onAbort = () => finish('cancelled', 'ABORT_ERR');
    if (options.signal?.aborted) return onAbort();
    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
    socket = net.createConnection({ host: address.address || address, port, family: address.family || undefined });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish('open'));
    socket.once('timeout', () => finish('timed_out', 'ETIMEDOUT'));
    socket.once('error', error => {
      if (error.code === 'ECONNREFUSED') finish('closed', error.code);
      else if (error.code === 'ETIMEDOUT') finish('timed_out', error.code);
      else if (['EHOSTUNREACH', 'ENETUNREACH'].includes(error.code)) finish('unreachable', error.code);
      else finish('error', error.code || 'SOCKET_ERROR');
    });
  });
}

async function mapLimit(items, limit, mapper, options = {}) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length && !options.signal?.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      if (options.signal?.aborted) break;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function runPortScanDiagnostic(target, options = {}) {
  const startedAt = Date.now();
  const ports = parsePortSpec(options.ports, { maxPorts: 32 });
  const timeoutMs = boundedInteger(options.timeoutMs, 1200, 300, 3000, 'INVALID_PORT_TIMEOUT');
  const resolution = options.resolution || await resolveTargetAddresses(target, { signal: options.signal, lookup: options.lookup });
  const selected = preferredAddress(resolution.addresses, target);
  if (!selected) {
    const diagnosis = resolutionFailureDiagnosis(resolution.error);
    return toolEnvelope({
      requestId: options.requestId,
      tool: 'portscan',
      ok: true,
      target,
      status: diagnosis.code === 'DNS_TIMEOUT' ? 'timed_out' : 'complete',
      diagnosis,
      durationMs: Date.now() - startedAt,
      timedOut: diagnosis.code === 'DNS_TIMEOUT',
      warnings: target.warnings,
      data: { host: target.host, resolved_addresses: [], selected_address: null, ports: [] },
    });
  }

  const portChecker = options.portChecker || checkTcpPort;
  const results = await mapLimit(ports, 8, port => portChecker(selected, port, { timeoutMs, signal: options.signal }), { signal: options.signal });
  if (options.signal?.aborted) return null;
  const counts = results.reduce((total, row) => {
    total[row.status] = (total[row.status] || 0) + 1;
    return total;
  }, {});
  let diagnosis;
  if (counts.open) diagnosis = { code: 'OPEN_PORTS_FOUND', severity: 'healthy', summary: `${counts.open} of ${results.length} scanned port(s) are open.` };
  else if ((counts.timed_out || 0) === results.length) diagnosis = { code: 'INCONCLUSIVE_FILTERED', severity: 'warning', summary: 'Every connection attempt timed out; traffic may be filtered or dropped.' };
  else if (counts.unreachable) diagnosis = { code: 'TARGET_UNREACHABLE', severity: 'error', summary: 'The VPS has no route to one or more requested ports.' };
  else if (counts.error) diagnosis = { code: 'PORT_SCAN_ERRORS', severity: 'error', summary: `No open ports were confirmed; ${counts.error} connection check(s) failed unexpectedly.` };
  else if (counts.timed_out) diagnosis = { code: 'NO_OPEN_PORTS_WITH_TIMEOUTS', severity: 'warning', summary: 'No open ports found; some attempts timed out.' };
  else diagnosis = { code: 'NO_OPEN_PORTS', severity: 'neutral', summary: 'All scanned ports refused or closed the TCP connection.' };

  const output = results.map(row => `Port ${row.port}${row.service ? ` (${row.service})` : ''}: ${row.status} [${row.latency_ms} ms]`).join('\n');
  return toolEnvelope({
    requestId: options.requestId,
    tool: 'portscan',
    ok: true,
    target,
    diagnosis,
    durationMs: Date.now() - startedAt,
    timedOut: Boolean(counts.timed_out),
    output,
    warnings: target.warnings,
    data: {
      host: target.host,
      resolved_addresses: resolution.addresses,
      selected_address: selected,
      scan_source: 'vps',
      ports: results,
      port_counts: counts,
    },
  });
}

function checkTlsService(target, address, options = {}) {
  const port = options.port || 443;
  const timeoutMs = options.timeoutMs || 2500;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let socket = null;
    const finish = (status, details = {}) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      socket?.destroy();
      resolve({ status, latency_ms: Date.now() - startedAt, ...details });
    };
    const onAbort = () => finish('cancelled', { error_code: 'ABORT_ERR' });
    if (options.signal?.aborted) return onAbort();
    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
    socket = tls.connect({
      host: address.address,
      family: address.family,
      port,
      servername: target.kind === 'hostname' ? target.host : undefined,
      rejectUnauthorized: true,
    });
    socket.setTimeout(timeoutMs);
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate();
      finish('secure', {
        protocol: socket.getProtocol(),
        authorized: socket.authorized,
        certificate: certificate && Object.keys(certificate).length ? {
          subject: certificate.subject?.CN || null,
          issuer: certificate.issuer?.CN || null,
          valid_to: certificate.valid_to || null,
        } : null,
      });
    });
    socket.once('timeout', () => finish('timed_out', { error_code: 'ETIMEDOUT' }));
    socket.once('error', error => finish('tls_error', { error_code: error.code || 'TLS_ERROR' }));
  });
}

function checkHttpService(target, address, options = {}) {
  const secure = options.secure !== false;
  const port = options.port || (secure ? 443 : 80);
  const timeoutMs = options.timeoutMs || 3000;
  const client = secure ? https : http;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let request;
    const finish = (status, details = {}) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      request?.destroy();
      resolve({ status, latency_ms: Date.now() - startedAt, protocol: secure ? 'https' : 'http', port, ...details });
    };
    const onAbort = () => finish('cancelled', { error_code: 'ABORT_ERR' });
    if (options.signal?.aborted) return onAbort();

    const displayHost = target.family === 6 ? `[${target.host}]` : target.host;
    const hostHeader = port === (secure ? 443 : 80) ? displayHost : `${displayHost}:${port}`;
    request = client.request({
      host: address.address,
      family: address.family,
      port,
      method: 'HEAD',
      path: '/',
      servername: target.kind === 'hostname' ? target.host : undefined,
      headers: { Host: hostHeader, 'User-Agent': 'VPS-Dashboard-Network-Diagnosis/2' },
      rejectUnauthorized: true,
    }, response => {
      response.resume();
      finish('reachable', {
        status_code: response.statusCode,
        server: response.headers.server || null,
        location: response.headers.location || null,
      });
    });
    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
    request.setTimeout(timeoutMs, () => finish('timed_out', { error_code: 'ETIMEDOUT' }));
    request.once('error', error => finish('http_error', { error_code: error.code || 'HTTP_ERROR' }));
    request.end();
  });
}

function diagnosisStage(id, state, code, summary, durationMs, details = {}) {
  return { id, state, code, summary, duration_ms: durationMs, details };
}

async function runNetworkDiagnosis(target, options = {}) {
  const startedAt = Date.now();
  const stages = [];
  const resolution = options.resolution || await resolveTargetAddresses(target, { signal: options.signal, lookup: options.lookup });
  const selected = preferredAddress(resolution.addresses, target);
  if (!selected) {
    const diagnosis = resolutionFailureDiagnosis(resolution.error);
    stages.push(diagnosisStage('dns', 'fail', diagnosis.code, diagnosis.summary, Date.now() - startedAt));
    return toolEnvelope({
      requestId: options.requestId,
      tool: 'diagnose',
      ok: true,
      target,
      status: diagnosis.code === 'DNS_TIMEOUT' ? 'timed_out' : 'complete',
      diagnosis,
      durationMs: Date.now() - startedAt,
      timedOut: diagnosis.code === 'DNS_TIMEOUT',
      warnings: target.warnings,
      data: { host: target.host, resolved_addresses: [], selected_address: null, stages },
    });
  }
  stages.push(diagnosisStage('dns', 'pass', 'RESOLVED', `Resolved to ${selected.address}.`, Date.now() - startedAt, { addresses: resolution.addresses }));

  const tcpChecker = options.tcpChecker || checkTcpPort;
  const tcpStarted = Date.now();
  const [tcp443, tcp80] = await Promise.all([
    tcpChecker(selected, 443, { timeoutMs: 1200, signal: options.signal }),
    tcpChecker(selected, 80, { timeoutMs: 1200, signal: options.signal }),
  ]);
  if (options.signal?.aborted) return null;
  const openTcp = [tcp443, tcp80].find(row => row.status === 'open');
  const tcpTimedOut = [tcp443, tcp80].some(row => row.status === 'timed_out');
  const tcpError = [tcp443, tcp80].some(row => row.status === 'error');
  const tcpUnreachable = [tcp443, tcp80].some(row => row.status === 'unreachable');
  const tcpCode = openTcp ? 'TCP_OPEN' : tcpTimedOut ? 'TCP_TIMEOUT' : tcpUnreachable ? 'TCP_UNREACHABLE' : tcpError ? 'TCP_ERROR' : 'NO_WEB_PORT';
  stages.push(diagnosisStage(
    'tcp',
    openTcp ? 'pass' : tcpTimedOut ? 'warn' : 'fail',
    tcpCode,
    openTcp ? `TCP port ${openTcp.port} is open.` : tcpTimedOut ? 'At least one web connection attempt timed out.' : 'Neither TCP 443 nor TCP 80 accepted a connection.',
    Date.now() - tcpStarted,
    { ports: [tcp443, tcp80] }
  ));

  const tlsChecker = options.tlsChecker || checkTlsService;
  let tlsResult = { status: 'skipped', latency_ms: 0 };
  if (tcp443.status === 'open') {
    tlsResult = await tlsChecker(target, selected, { port: 443, signal: options.signal });
    if (options.signal?.aborted) return null;
    stages.push(diagnosisStage(
      'tls',
      tlsResult.status === 'secure' ? 'pass' : tlsResult.status === 'timed_out' ? 'warn' : 'fail',
      tlsResult.status === 'secure' ? 'TLS_OK' : tlsResult.status === 'timed_out' ? 'TLS_TIMEOUT' : 'TLS_ERROR',
      tlsResult.status === 'secure' ? `TLS handshake succeeded with ${tlsResult.protocol || 'an encrypted protocol'}.` : 'TLS handshake did not complete successfully.',
      tlsResult.latency_ms,
      tlsResult
    ));
  } else {
    stages.push(diagnosisStage('tls', 'skipped', 'TLS_SKIPPED', 'TLS skipped because TCP 443 is not open.', 0));
  }

  const httpChecker = options.httpChecker || checkHttpService;
  let httpResult = { status: 'skipped', latency_ms: 0 };
  const httpAttempts = [];
  if (tlsResult.status === 'secure') {
    httpResult = await httpChecker(target, selected, { secure: true, port: 443, signal: options.signal });
    httpAttempts.push(httpResult);
  }
  if (httpResult.status !== 'reachable' && tcp80.status === 'open') {
    httpResult = await httpChecker(target, selected, { secure: false, port: 80, signal: options.signal });
    httpAttempts.push(httpResult);
  }
  if (options.signal?.aborted) return null;
  stages.push(diagnosisStage(
    'http',
    httpResult.status === 'reachable' ? 'pass' : httpResult.status === 'skipped' ? 'skipped' : httpResult.status === 'timed_out' ? 'warn' : 'fail',
    httpResult.status === 'reachable' ? 'HTTP_REACHABLE' : httpResult.status === 'skipped' ? 'HTTP_SKIPPED' : httpResult.status === 'timed_out' ? 'HTTP_TIMEOUT' : 'HTTP_ERROR',
    httpResult.status === 'reachable' ? `${httpResult.protocol.toUpperCase()} responded with status ${httpResult.status_code}.` : httpResult.status === 'skipped' ? 'HTTP skipped because no compatible web transport was available.' : 'HTTP request did not complete successfully.',
    httpResult.latency_ms,
    { ...httpResult, attempts: httpAttempts }
  ));

  const pingDiagnostic = options.pingDiagnostic || runPingDiagnostic;
  const pingPayload = await pingDiagnostic(target, {
    requestId: options.requestId,
    signal: options.signal,
    count: 2,
    resolution,
  });
  if (options.signal?.aborted || !pingPayload) return null;
  const pingReachable = pingPayload.diagnosis.code === 'REACHABLE';
  stages.push(diagnosisStage(
    'icmp',
    pingReachable ? 'pass' : 'warn',
    pingPayload.diagnosis.code,
    pingPayload.diagnosis.summary,
    pingPayload.duration_ms,
    { ping: pingPayload.ping }
  ));

  let tracePayload = null;
  if (options.includeTrace) {
    const traceDiagnostic = options.traceDiagnostic || runTraceDiagnostic;
    tracePayload = await traceDiagnostic(target, {
      requestId: options.requestId,
      signal: options.signal,
      maxHops: options.maxHops || 12,
      mode: options.traceMode,
      resolution,
    });
    if (options.signal?.aborted || !tracePayload) return null;
    stages.push(diagnosisStage(
      'trace',
      tracePayload.diagnosis.code === 'TRACE_REACHED' ? 'pass' : 'warn',
      tracePayload.diagnosis.code,
      tracePayload.diagnosis.summary,
      tracePayload.duration_ms,
      { hops: tracePayload.trace.hops }
    ));
  } else {
    stages.push(diagnosisStage('trace', 'skipped', 'TRACE_OPTIONAL', 'Traceroute was not requested for this quick diagnosis.', 0));
  }

  let diagnosis;
  if (httpResult.status === 'reachable' && !pingReachable) {
    diagnosis = { code: 'REACHABLE_ICMP_FILTERED', severity: 'healthy', summary: 'The web service is reachable even though ICMP did not reply.' };
  } else if (httpResult.status === 'reachable') {
    diagnosis = { code: 'APPLICATION_REACHABLE', severity: 'healthy', summary: 'DNS, transport, and application checks confirm the target is reachable.' };
  } else if (pingReachable) {
    diagnosis = { code: 'HOST_REACHABLE_NO_WEB_SERVICE', severity: 'warning', summary: 'The host replies to ICMP, but no working web service was confirmed.' };
  } else if (openTcp) {
    diagnosis = { code: 'TCP_REACHABLE_APPLICATION_UNCONFIRMED', severity: 'warning', summary: `TCP port ${openTcp.port} accepts connections, but no working web application was confirmed.` };
  } else if ([tcp443.status, tcp80.status].every(status => status === 'timed_out')) {
    diagnosis = { code: 'INCONCLUSIVE_FILTERED', severity: 'warning', summary: 'ICMP and web connections did not reply; filtering or packet drops may be involved.' };
  } else {
    diagnosis = { code: 'NO_REACHABILITY_EVIDENCE', severity: 'warning', summary: 'The checks found no positive reachability evidence, but do not prove the host is offline.' };
  }

  const output = stages.map(stage => `${stage.id.toUpperCase()}: ${stage.code} - ${stage.summary}`).join('\n');
  return toolEnvelope({
    requestId: options.requestId,
    tool: 'diagnose',
    ok: true,
    status: 'complete',
    target,
    diagnosis,
    durationMs: Date.now() - startedAt,
    timedOut: stages.some(stage => /TIMEOUT/.test(stage.code)),
    output,
    warnings: target.warnings,
    data: {
      host: target.host,
      resolved_addresses: resolution.addresses,
      selected_address: selected,
      stages,
      ping: pingPayload.ping,
      trace: tracePayload?.trace || null,
    },
  });
}

module.exports = {
  ToolServiceError,
  boundedInteger,
  checkHttpService,
  checkTcpPort,
  checkTlsService,
  buildTracePlans,
  dnsErrorDiagnosis,
  findExecutable,
  formatMtrTraceOutput,
  formatDnsRecords,
  mapLimit,
  normalizeRecordType,
  normalizeTraceMode,
  parseMtrJson,
  parsePingOutput,
  parsePortSpec,
  parseTraceOutput,
  preferredAddress,
  resolutionFailureDiagnosis,
  resolveTargetAddresses,
  runDnsDiagnostic,
  runNetworkDiagnosis,
  runPingDiagnostic,
  runPortScanDiagnostic,
  runTraceDiagnostic,
};
