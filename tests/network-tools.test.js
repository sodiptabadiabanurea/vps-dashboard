'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const express = require('express');
const {
  commandOutput,
  createOperationLimiter,
  normalizeTarget,
  publicExecution,
  runCommand,
  toolEnvelope,
} = require('../modules/network-tools-core');
const {
  buildTracePlans,
  checkTcpPort,
  mapLimit,
  normalizeRecordType,
  normalizeTraceMode,
  parseMtrJson,
  parsePingOutput,
  parsePortSpec,
  parseTraceOutput,
  runDnsDiagnostic,
  runNetworkDiagnosis,
  runPingDiagnostic,
  runPortScanDiagnostic,
  runTraceDiagnostic,
  resolutionFailureDiagnosis,
} = require('../modules/network-diagnostics');
const { parseBooleanValue, setupNetworkToolRoutes } = require('../modules/network-tools');

function commandResult(overrides = {}) {
  return {
    ok: true,
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    truncated: false,
    durationMs: 20,
    stdout: '',
    stderr: '',
    errorCode: null,
    error: null,
    ...overrides,
  };
}

test('structured command runner records successful output and duration', async () => {
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("runner-ok")']);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'runner-ok');
  assert.equal(result.stderr, '');
  assert.equal(result.timedOut, false);
  assert.ok(result.durationMs >= 0);
});

test('structured command runner preserves nonzero exit evidence', async () => {
  const result = await runCommand(process.execPath, ['-e', 'process.stderr.write("runner-failed");process.exit(3)']);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.equal(result.stderr, 'runner-failed');
  assert.equal(commandOutput(result), 'runner-failed');
});

test('structured command runner reports timeout with partial output', async () => {
  const result = await runCommand(
    process.execPath,
    ['-e', 'process.stdout.write("partial");setTimeout(()=>{},5000)'],
    // Allow child startup headroom when test files execute in parallel on Node 18.
    { timeoutMs: 1500 }
  );
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.stdout, 'partial');
});

test('structured command runner aborts the child process', async () => {
  const controller = new AbortController();
  const pending = runCommand(
    process.execPath,
    ['-e', 'setTimeout(()=>{},5000)'],
    { timeoutMs: 5000, signal: controller.signal }
  );
  setTimeout(() => controller.abort(), 40);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
});

test('structured command runner bounds captured output', async () => {
  const result = await runCommand(
    process.execPath,
    ['-e', 'process.stdout.write("x".repeat(64))'],
    { maxBuffer: 12 }
  );
  assert.equal(result.stdout.length, 12);
  assert.equal(result.truncated, true);
});

test('tool envelope keeps execution metadata separate from diagnosis', () => {
  const execution = publicExecution({
    exitCode: 1,
    signal: null,
    timedOut: false,
    aborted: false,
    truncated: false,
    durationMs: 15,
    errorCode: null,
  }, 'ping');
  const payload = toolEnvelope({
    requestId: 'request-test',
    tool: 'ping',
    ok: true,
    target: { host: '127.0.0.1' },
    diagnosis: { code: 'NO_ICMP_REPLY', severity: 'warning', summary: 'No reply.' },
    durationMs: 15,
    execution,
  });
  assert.equal(payload.schema_version, 2);
  assert.equal(payload.ok, true);
  assert.equal(payload.execution.exit_code, 1);
  assert.equal(payload.diagnosis.code, 'NO_ICMP_REPLY');
});

test('target parser accepts hostnames, IPs, bracketed IPv6, and http URLs', () => {
  assert.equal(normalizeTarget('Example.COM.').host, 'example.com');
  assert.equal(normalizeTarget('127.0.0.1').scope, 'loopback');
  assert.equal(normalizeTarget('[::1]').host, '::1');
  const url = normalizeTarget('https://Example.com:8443/path?q=1');
  assert.equal(url.host, 'example.com');
  assert.equal(url.normalized_from_url, true);
  assert.deepEqual(url.warnings, ['URL_NORMALIZED_TO_HOST', 'URL_PORT_IGNORED', 'URL_PATH_IGNORED']);
});

test('target parser supports IDN and DNS underscore mode', () => {
  assert.match(normalizeTarget('münich.example').host, /^xn--/);
  assert.equal(normalizeTarget('_dmarc.example.com', { allowUnderscore: true }).host, '_dmarc.example.com');
});

test('target parser rejects option-like, credential, malformed, and host-port input', () => {
  const invalid = [
    '-V',
    'https://user:pass@example.com',
    'example..com',
    '999.999.999.999',
    'example.com:443',
    'example.com/path',
    'bad\u0000host',
  ];
  for (const value of invalid) assert.throws(() => normalizeTarget(value), { name: 'ToolInputError' });
});

test('operation limiter enforces global and per-tool limits and releases once', () => {
  const limiter = createOperationLimiter({ globalLimit: 2, perToolLimit: { traceroute: 1 } });
  const releaseTrace = limiter.acquire('traceroute');
  assert.equal(typeof releaseTrace, 'function');
  assert.equal(limiter.acquire('traceroute'), null);
  const releasePing = limiter.acquire('ping');
  assert.equal(typeof releasePing, 'function');
  assert.equal(limiter.acquire('dns'), null);
  releaseTrace();
  releaseTrace();
  const releaseDns = limiter.acquire('dns');
  assert.equal(typeof releaseDns, 'function');
  releaseDns();
  releasePing();
  assert.deepEqual(limiter.snapshot(), { activeGlobal: 0, activeByTool: {} });
});

test('ping parser extracts packet loss and latency statistics', () => {
  const parsed = parsePingOutput('3 packets transmitted, 2 received, 33.3333% packet loss\nrtt min/avg/max/mdev = 1.1/2.2/3.3/0.4 ms');
  assert.equal(parsed.sent, 3);
  assert.equal(parsed.received, 2);
  assert.equal(parsed.packet_loss_percent, 33.3333);
  assert.equal(parsed.latency_ms.avg, 2.2);
});

test('ping diagnostic uses fast bounded arguments and distinguishes ICMP silence', async () => {
  let observedArgs;
  let observedOptions;
  const payload = await runPingDiagnostic(normalizeTarget('example.com'), {
    requestId: 'ping-test',
    count: 3,
    resolution: { addresses: [{ address: '203.0.113.7', family: 4 }], error: null },
    pingPath: '/usr/bin/ping',
    runner: async (_command, args, runOptions) => {
      observedArgs = args;
      observedOptions = runOptions;
      return commandResult({ ok: false, exitCode: 1, stdout: '3 packets transmitted, 0 received, 100% packet loss' });
    },
  });
  assert.deepEqual(observedArgs.slice(0, 2), ['-n', '-4']);
  assert.ok(observedArgs.includes('-i'));
  assert.equal(observedArgs.includes('-w'), false);
  assert.equal(observedArgs.at(-2), '--');
  assert.ok(observedOptions.timeoutMs <= 3000);
  assert.equal(payload.ok, true);
  assert.equal(payload.diagnosis.code, 'NO_ICMP_REPLY');
  assert.equal(payload.ping.packet_loss_percent, 100);
});

test('trace parser preserves partial hops and detects reached targets', () => {
  const partial = parseTraceOutput(' 1:  10.0.0.1  0.4ms\n 2:  no reply', '203.0.113.7');
  assert.equal(partial.reached_target, false);
  assert.equal(partial.hops.length, 2);
  const reached = parseTraceOutput(' 1:  203.0.113.7  0.8ms reached', '203.0.113.7');
  assert.equal(reached.reached_target, true);
});

test('MTR JSON parser detects the target and preserves hop metrics', () => {
  const parsed = parseMtrJson(JSON.stringify({
    report: {
      hubs: [
        { count: 1, host: '10.0.0.1', 'Loss%': 0, Snt: 1, Last: 0.4, Avg: 0.4, Best: 0.4, Wrst: 0.4, StDev: 0 },
        { count: 2, host: '203.0.113.7', 'Loss%': 0, Snt: 1, Last: 1.2, Avg: 1.2, Best: 1.2, Wrst: 1.2, StDev: 0 },
      ],
    },
  }), '203.0.113.7');
  assert.equal(parsed.valid, true);
  assert.equal(parsed.reached_target, true);
  assert.equal(parsed.hops[1].latency_ms, 1.2);
  assert.equal(parsed.hops[1].loss_percent, 0);
});

test('trace auto mode prefers bounded MTR TCP 443 and formats readable output', async () => {
  const calls = [];
  const payload = await runTraceDiagnostic(normalizeTarget('example.com'), {
    resolution: { addresses: [{ address: '203.0.113.7', family: 4 }], error: null },
    mtrPath: '/usr/bin/mtr',
    traceroutePath: null,
    tracepathPath: '/usr/bin/tracepath',
    runner: async (command, args, options) => {
      calls.push({ command, args, options });
      return commandResult({
        stdout: JSON.stringify({
          report: {
            hubs: [
              { count: 1, host: '10.0.0.1', 'Loss%': 0, Snt: 1, Last: 0.5, Avg: 0.5, Best: 0.5, Wrst: 0.5, StDev: 0 },
              { count: 2, host: '203.0.113.7', 'Loss%': 0, Snt: 1, Last: 1.5, Avg: 1.5, Best: 1.5, Wrst: 1.5, StDev: 0 },
            ],
          },
        }),
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/usr/bin/mtr');
  assert.deepEqual(calls[0].args, ['-4', '-T', '-P', '443', '-n', '-r', '-j', '-c', '1', '-m', '12', '-G', '1', '-Z', '1', '--', '203.0.113.7']);
  assert.ok(calls[0].options.timeoutMs <= 12000);
  assert.equal(payload.provider, 'mtr');
  assert.equal(payload.requested_mode, 'auto');
  assert.equal(payload.mode, 'tcp');
  assert.equal(payload.transport, 'tcp');
  assert.equal(payload.port, 443);
  assert.equal(payload.trace.reached_target, true);
  assert.equal(payload.status, 'complete');
  assert.equal(payload.diagnosis.code, 'TRACE_REACHED');
  assert.equal(payload.trace_attempts.length, 1);
  assert.match(payload.output, /^1  10\.0\.0\.1/m);
  assert.equal(payload.output.trim().startsWith('{'), false);
});

test('trace auto mode falls back from unavailable MTR TCP to tracepath UDP', async () => {
  const calls = [];
  const payload = await runTraceDiagnostic(normalizeTarget('example.com'), {
    resolution: { addresses: [{ address: '203.0.113.7', family: 4 }], error: null },
    mtrPath: '/usr/bin/mtr',
    traceroutePath: null,
    tracepathPath: '/usr/bin/tracepath',
    runner: async (command, args) => {
      calls.push({ command, args });
      if (command.endsWith('/mtr')) return commandResult({ ok: false, exitCode: 1, stderr: "mtr: invalid option -- 'T'" });
      return commandResult({ stdout: ' 1:  203.0.113.7  0.8ms reached' });
    },
  });

  assert.deepEqual(calls.map(call => call.command), ['/usr/bin/mtr', '/usr/bin/tracepath']);
  assert.equal(payload.provider, 'tracepath');
  assert.equal(payload.mode, 'udp');
  assert.equal(payload.port, null);
  assert.equal(payload.diagnosis.code, 'TRACE_REACHED');
  assert.equal(payload.trace_attempts.length, 2);
  assert.ok(payload.warnings.includes('TRACE_FALLBACK_MTR_TCP_UNAVAILABLE'));
});

test('trace auto mode uses traceroute TCP 443 and falls back to UDP only when unsupported', async () => {
  const calls = [];
  const payload = await runTraceDiagnostic(normalizeTarget('example.com'), {
    resolution: { addresses: [{ address: '203.0.113.7', family: 4 }], error: null },
    mtrPath: null,
    traceroutePath: '/usr/bin/traceroute',
    tracepathPath: null,
    runner: async (_command, args) => {
      calls.push(args);
      if (args.includes('-T')) return commandResult({ ok: false, exitCode: 2, stderr: "traceroute: invalid option -- 'T'" });
      return commandResult({ stdout: '1  203.0.113.7  0.8 ms' });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].includes('-T'), true);
  assert.equal(calls[0].includes('443'), true);
  assert.equal(calls[1].includes('-T'), false);
  assert.equal(payload.provider, 'traceroute');
  assert.equal(payload.mode, 'udp');
  assert.equal(payload.diagnosis.code, 'TRACE_REACHED');
  assert.ok(payload.warnings.includes('TRACE_FALLBACK_TRACEROUTE_TCP_UNAVAILABLE'));
});

test('trace mode validation is explicit', () => {
  assert.equal(normalizeTraceMode(), 'auto');
  assert.equal(normalizeTraceMode('TCP'), 'tcp');
  assert.throws(() => normalizeTraceMode('icmp'), { name: 'ToolInputError' });
  const ipv6Plan = buildTracePlans({ mtr: '/usr/bin/mtr', traceroute: null, tracepath: null }, 'tcp', 12, '2001:db8::7')[0];
  assert.equal(ipv6Plan.args[0], '-6');
});

test('trace diagnostic returns partial evidence when its deadline expires', async () => {
  const payload = await runTraceDiagnostic(normalizeTarget('example.com'), {
    requestId: 'trace-test',
    maxHops: 12,
    resolution: { addresses: [{ address: '203.0.113.7', family: 4 }], error: null },
    tracerPath: '/usr/bin/tracepath',
    runner: async () => commandResult({ ok: false, timedOut: true, signal: 'SIGTERM', stdout: ' 1:  10.0.0.1  0.4ms\n 2:  no reply' }),
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.status, 'partial');
  assert.equal(payload.diagnosis.code, 'TRACE_PARTIAL_TIMEOUT');
  assert.equal(payload.trace.hops.length, 2);
});

test('trace timeout without hop evidence uses a timed-out envelope', async () => {
  const payload = await runTraceDiagnostic(normalizeTarget('example.com'), {
    resolution: { addresses: [{ address: '203.0.113.7', family: 4 }], error: null },
    tracerPath: '/usr/bin/tracepath',
    runner: async () => commandResult({ ok: false, timedOut: true, signal: 'SIGTERM' }),
  });
  assert.equal(payload.diagnosis.code, 'TRACE_FILTERED_NO_RESPONSE');
  assert.equal(payload.diagnosis.severity, 'warning');
  assert.equal(payload.status, 'timed_out');
  assert.equal(payload.timed_out, true);
});

test('address resolution failures distinguish not-found from transient resolver errors', () => {
  assert.equal(resolutionFailureDiagnosis({ code: 'ENOTFOUND' }).code, 'TARGET_NOT_FOUND');
  assert.equal(resolutionFailureDiagnosis({ code: 'ETIMEOUT' }).code, 'DNS_TIMEOUT');
  assert.equal(resolutionFailureDiagnosis({ code: 'EAI_AGAIN' }).code, 'DNS_TEMPORARY_FAILURE');
  assert.equal(resolutionFailureDiagnosis({ code: 'ESERVFAIL' }).code, 'DNS_SERVFAIL');
});

test('DNS diagnostic distinguishes answers, no data, and NXDOMAIN', async () => {
  const target = normalizeTarget('example.com');
  const answer = await runDnsDiagnostic(target, {
    recordType: 'A',
    resolver: {
      resolve4: async () => [{ address: '203.0.113.7', ttl: 60 }],
      getServers: () => ['127.0.0.53'],
    },
  });
  assert.equal(answer.diagnosis.code, 'ANSWER');
  assert.deepEqual(answer.result, ['203.0.113.7 TTL=60']);

  const noData = await runDnsDiagnostic(target, {
    recordType: 'AAAA',
    resolver: {
      resolve6: async () => { const error = new Error('no data'); error.code = 'ENODATA'; throw error; },
      getServers: () => [],
    },
  });
  assert.equal(noData.diagnosis.code, 'NO_DATA');

  const nxdomain = await runDnsDiagnostic(target, {
    recordType: 'MX',
    resolver: {
      resolveMx: async () => { const error = new Error('not found'); error.code = 'ENOTFOUND'; throw error; },
      getServers: () => [],
    },
  });
  assert.equal(nxdomain.diagnosis.code, 'NXDOMAIN');
  assert.equal(nxdomain.ok, true);
});

test('DNS record type validation is explicit', () => {
  assert.equal(normalizeRecordType('txt'), 'TXT');
  assert.throws(() => normalizeRecordType('SRV'), { name: 'ToolInputError' });
});

test('port parser expands bounded ranges, deduplicates, and rejects invalid input', () => {
  assert.deepEqual(parsePortSpec('22,80,80,443-445'), [22, 80, 443, 444, 445]);
  assert.throws(() => parsePortSpec('0'), { name: 'ToolInputError' });
  assert.throws(() => parsePortSpec('1-40', { maxPorts: 32 }), { name: 'ToolInputError' });
  assert.throws(() => parsePortSpec('22,bad'), { name: 'ToolInputError' });
});

test('TCP port checker distinguishes open and refused connections', async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const openPort = server.address().port;
  const open = await checkTcpPort({ address: '127.0.0.1', family: 4 }, openPort, { timeoutMs: 500 });
  assert.equal(open.status, 'open');
  await new Promise(resolve => server.close(resolve));
  const closed = await checkTcpPort({ address: '127.0.0.1', family: 4 }, openPort, { timeoutMs: 500 });
  assert.equal(closed.status, 'closed');
  assert.equal(closed.error_code, 'ECONNREFUSED');
});

test('TCP port checker honours an already-aborted request before connecting', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await checkTcpPort({ address: '203.0.113.7', family: 4 }, 443, { signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error_code, 'ABORT_ERR');
});

test('bounded workers stop starting new items after cancellation', async () => {
  const controller = new AbortController();
  const started = [];
  await mapLimit([1, 2, 3], 1, async item => {
    started.push(item);
    controller.abort();
  }, { signal: controller.signal });
  assert.deepEqual(started, [1]);
});

test('port scan resolves once and preserves distinct port outcomes', async () => {
  const outcomes = new Map([[22, 'open'], [80, 'closed'], [443, 'timed_out']]);
  const payload = await runPortScanDiagnostic(normalizeTarget('example.com'), {
    ports: '22,80,443',
    resolution: { addresses: [{ address: '203.0.113.7', family: 4 }], error: null },
    portChecker: async (_address, port) => ({ port, status: outcomes.get(port), latency_ms: 5, error_code: null }),
  });
  assert.equal(payload.diagnosis.code, 'OPEN_PORTS_FOUND');
  assert.deepEqual(payload.ports.map(row => row.status), ['open', 'closed', 'timed_out']);
  assert.equal(payload.timed_out, true);
});

test('port scan reports resolution failure instead of false closed ports', async () => {
  const payload = await runPortScanDiagnostic(normalizeTarget('does-not-exist.invalid'), {
    ports: '22,80',
    resolution: { addresses: [], error: { code: 'ENOTFOUND' } },
  });
  assert.equal(payload.diagnosis.code, 'TARGET_NOT_FOUND');
  assert.deepEqual(payload.ports, []);
});

test('port scan preserves transient DNS and unexpected socket errors', async () => {
  const timeout = await runPortScanDiagnostic(normalizeTarget('example.com'), {
    ports: '443',
    resolution: { addresses: [], error: { code: 'ETIMEOUT' } },
  });
  assert.equal(timeout.diagnosis.code, 'DNS_TIMEOUT');
  assert.equal(timeout.status, 'timed_out');

  const socketError = await runPortScanDiagnostic(normalizeTarget('example.com'), {
    ports: '80,443',
    resolution: { addresses: [{ address: '203.0.113.7', family: 4 }], error: null },
    portChecker: async (_address, port) => ({ port, status: port === 80 ? 'closed' : 'error', latency_ms: 1, error_code: port === 80 ? 'ECONNREFUSED' : 'EACCES' }),
  });
  assert.equal(socketError.diagnosis.code, 'PORT_SCAN_ERRORS');
  assert.equal(socketError.diagnosis.severity, 'error');
});

test('unified diagnosis prefers HTTP evidence over missing ICMP replies', async () => {
  const target = normalizeTarget('example.com');
  const payload = await runNetworkDiagnosis(target, {
    resolution: { addresses: [{ address: '203.0.113.7', family: 4 }], error: null },
    tcpChecker: async (_address, port) => ({ port, status: port === 443 ? 'open' : 'closed', latency_ms: 2, error_code: null }),
    tlsChecker: async () => ({ status: 'secure', latency_ms: 3, protocol: 'TLSv1.3' }),
    httpChecker: async () => ({ status: 'reachable', latency_ms: 4, protocol: 'https', status_code: 200 }),
    pingDiagnostic: async () => ({ diagnosis: { code: 'NO_ICMP_REPLY', summary: 'No reply.' }, duration_ms: 5, ping: { sent: 2, received: 0, packet_loss_percent: 100 } }),
  });
  assert.equal(payload.diagnosis.code, 'REACHABLE_ICMP_FILTERED');
  assert.equal(payload.stages.length, 6);
  assert.equal(payload.stages.find(stage => stage.id === 'http').state, 'pass');
  assert.equal(payload.stages.find(stage => stage.id === 'icmp').state, 'warn');
});

test('unified diagnosis short-circuits safely when DNS resolution fails', async () => {
  let tcpCalls = 0;
  const payload = await runNetworkDiagnosis(normalizeTarget('does-not-exist.invalid'), {
    resolution: { addresses: [], error: { code: 'ENOTFOUND' } },
    tcpChecker: async () => { tcpCalls += 1; },
  });
  assert.equal(payload.diagnosis.code, 'TARGET_NOT_FOUND');
  assert.equal(payload.stages.length, 1);
  assert.equal(tcpCalls, 0);
});

test('unified diagnosis does not call a reachable ICMP host offline when web ports are closed', async () => {
  const payload = await runNetworkDiagnosis(normalizeTarget('example.com'), {
    resolution: { addresses: [{ address: '203.0.113.7', family: 4 }], error: null },
    tcpChecker: async (_address, port) => ({ port, status: 'closed', latency_ms: 2, error_code: 'ECONNREFUSED' }),
    pingDiagnostic: async () => ({ diagnosis: { code: 'REACHABLE', summary: 'Reply received.' }, duration_ms: 5, ping: { sent: 2, received: 2, packet_loss_percent: 0 } }),
  });
  assert.equal(payload.diagnosis.code, 'HOST_REACHABLE_NO_WEB_SERVICE');
  assert.equal(payload.diagnosis.severity, 'warning');
});

test('unified diagnosis labels all-timeout evidence as inconclusive', async () => {
  const payload = await runNetworkDiagnosis(normalizeTarget('example.com'), {
    resolution: { addresses: [{ address: '203.0.113.7', family: 4 }], error: null },
    tcpChecker: async (_address, port) => ({ port, status: 'timed_out', latency_ms: 1200, error_code: 'ETIMEDOUT' }),
    pingDiagnostic: async () => ({ diagnosis: { code: 'NO_ICMP_REPLY', summary: 'No reply.' }, duration_ms: 5, ping: { sent: 2, received: 0, packet_loss_percent: 100 } }),
  });
  assert.equal(payload.diagnosis.code, 'INCONCLUSIVE_FILTERED');
  assert.equal(payload.timed_out, true);
});

test('unified diagnosis checks both web ports and falls back from failed HTTPS to HTTP', async () => {
  const tcpCalls = [];
  const httpCalls = [];
  const payload = await runNetworkDiagnosis(normalizeTarget('example.com'), {
    resolution: { addresses: [{ address: '203.0.113.7', family: 4 }], error: null },
    tcpChecker: async (_address, port) => {
      tcpCalls.push(port);
      return { port, status: 'open', latency_ms: 1, error_code: null };
    },
    tlsChecker: async () => ({ status: 'secure', latency_ms: 1, protocol: 'TLSv1.3' }),
    httpChecker: async (_target, _address, options) => {
      httpCalls.push(options.port);
      return options.secure
        ? { status: 'http_error', latency_ms: 1, protocol: 'https', port: 443, error_code: 'ECONNRESET' }
        : { status: 'reachable', latency_ms: 1, protocol: 'http', port: 80, status_code: 200 };
    },
    pingDiagnostic: async () => ({ diagnosis: { code: 'NO_ICMP_REPLY', summary: 'No reply.' }, duration_ms: 1, ping: { sent: 2, received: 0, packet_loss_percent: 100 } }),
  });
  assert.deepEqual(tcpCalls.sort((a, b) => a - b), [80, 443]);
  assert.deepEqual(httpCalls, [443, 80]);
  assert.equal(payload.diagnosis.code, 'REACHABLE_ICMP_FILTERED');
});

test('unified diagnosis treats transport-only evidence conservatively', async () => {
  const payload = await runNetworkDiagnosis(normalizeTarget('example.com'), {
    resolution: { addresses: [{ address: '203.0.113.7', family: 4 }], error: null },
    tcpChecker: async (_address, port) => ({ port, status: port === 443 ? 'open' : 'closed', latency_ms: 1, error_code: null }),
    tlsChecker: async () => ({ status: 'tls_error', latency_ms: 1, error_code: 'CERT_HAS_EXPIRED' }),
    pingDiagnostic: async () => ({ diagnosis: { code: 'NO_ICMP_REPLY', summary: 'No reply.' }, duration_ms: 1, ping: { sent: 2, received: 0, packet_loss_percent: 100 } }),
  });
  assert.equal(payload.diagnosis.code, 'TCP_REACHABLE_APPLICATION_UNCONFIRMED');
  assert.equal(payload.diagnosis.severity, 'warning');
});

test('boolean request values do not treat the string false as enabled', () => {
  assert.equal(parseBooleanValue('false', 'include_trace'), false);
  assert.equal(parseBooleanValue('true', 'include_trace'), true);
  assert.throws(() => parseBooleanValue('sometimes', 'include_trace'), { name: 'ToolInputError' });
});

test('v2 HTTP routes enforce auth, no-store, and stable validation errors', async () => {
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => {
    if (req.headers.authorization !== 'Basic test') return res.status(401).json({ error: 'Authentication required' });
    next();
  };
  setupNetworkToolRoutes(app, requireAuth);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const anonymous = await fetch(`${base}/api/tools/v2/ping`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: '127.0.0.1' }),
    });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get('cache-control'), 'private, no-store');

    const invalid = await fetch(`${base}/api/tools/v2/ping`, {
      method: 'POST', headers: { Authorization: 'Basic test', 'Content-Type': 'application/json' }, body: JSON.stringify({ target: '-V' }),
    });
    const payload = await invalid.json();
    assert.equal(invalid.status, 400);
    assert.equal(invalid.headers.get('cache-control'), 'private, no-store');
    assert.equal(payload.diagnosis.code, 'INVALID_TARGET');
    assert.equal(payload.tool, 'ping');

    const invalidTraceMode = await fetch(`${base}/api/tools/v2/trace`, {
      method: 'POST', headers: { Authorization: 'Basic test', 'Content-Type': 'application/json' }, body: JSON.stringify({ target: '127.0.0.1', mode: 'icmp' }),
    });
    const invalidTraceModePayload = await invalidTraceMode.json();
    assert.equal(invalidTraceMode.status, 400);
    assert.equal(invalidTraceModePayload.diagnosis.code, 'INVALID_TRACE_MODE');
    assert.equal(invalidTraceModePayload.tool, 'traceroute');

    const invalidBoolean = await fetch(`${base}/api/tools/v2/diagnose`, {
      method: 'POST', headers: { Authorization: 'Basic test', 'Content-Type': 'application/json' }, body: JSON.stringify({ target: '127.0.0.1', include_trace: 'sometimes' }),
    });
    const invalidBooleanPayload = await invalidBoolean.json();
    assert.equal(invalidBoolean.status, 400);
    assert.equal(invalidBooleanPayload.diagnosis.code, 'INVALID_BOOLEAN');
    assert.equal(invalidBooleanPayload.tool, 'diagnose');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
