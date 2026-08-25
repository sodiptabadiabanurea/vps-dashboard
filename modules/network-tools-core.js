'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const { domainToASCII } = require('url');

const DEFAULT_MAX_BUFFER = 1024 * 1024;

class ToolInputError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ToolInputError';
    this.code = code;
    this.statusCode = 400;
    this.details = details;
  }
}

function classifyAddress(host, family) {
  const value = host.toLowerCase();
  if (value === 'localhost' || value === '127.0.0.1' || value === '::1') return 'loopback';
  if (family === 4) {
    const parts = value.split('.').map(Number);
    if (parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)) return 'private';
    if (parts[0] === 169 && parts[1] === 254) return 'link_local';
  }
  if (family === 6) {
    if (value.startsWith('fe80:')) return 'link_local';
    if (value.startsWith('fc') || value.startsWith('fd')) return 'private';
  }
  return 'public';
}

function normalizeTarget(rawInput, options = {}) {
  const { allowUnderscore = false, allowUrl = true } = options;
  const input = String(rawInput ?? '').trim();
  if (!input) throw new ToolInputError('INVALID_TARGET', 'Enter a hostname or IP address.');
  if (input.length > 2048) throw new ToolInputError('INVALID_TARGET', 'Target is too long.');
  if(/[\u0000-\u001f\u007f]/.test(input)) throw new ToolInputError('INVALID_TARGET', 'Target contains control characters.');

  let candidate = input;
  let normalizedFromUrl = false;
  const warnings = [];
  const schemeMatch = input.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    if (!allowUrl) throw new ToolInputError('URL_NOT_ALLOWED', 'Enter a hostname or IP address without a URL scheme.');
    if (!['http', 'https'].includes(schemeMatch[1].toLowerCase())) {
      throw new ToolInputError('INVALID_SCHEME', 'Only http:// and https:// URLs can be normalized.');
    }
    let parsed;
    try {
      parsed = new URL(input);
    } catch (_) {
      throw new ToolInputError('INVALID_TARGET', 'The URL is malformed.');
    }
    if (parsed.username || parsed.password) {
      throw new ToolInputError('URL_CREDENTIALS_NOT_ALLOWED', 'Credentials are not allowed in a diagnostic target.');
    }
    candidate = parsed.hostname;
    normalizedFromUrl = true;
    warnings.push('URL_NORMALIZED_TO_HOST');
    if (parsed.port) warnings.push('URL_PORT_IGNORED');
    if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) warnings.push('URL_PATH_IGNORED');
  } else if (/[/?#@]/.test(input)) {
    throw new ToolInputError('INVALID_TARGET', 'Enter a hostname, IP address, or complete http(s) URL.');
  }

  if (candidate.startsWith('[') && candidate.endsWith(']')) candidate = candidate.slice(1, -1);
  if (!candidate || candidate.startsWith('-')) {
    throw new ToolInputError('INVALID_TARGET', 'Target cannot begin with an option prefix.');
  }
  if (net.isIP(candidate) === 0 && /^[^:]+:\d+$/.test(candidate)) {
    throw new ToolInputError('HOST_PORT_NOT_ALLOWED', 'Enter ports in the port field, not after the hostname.');
  }
  if (/^\d+(?:\.\d+){3}$/.test(candidate) && net.isIP(candidate) === 0) {
    throw new ToolInputError('INVALID_IP', 'IPv4 address is outside the valid range.');
  }

  const family = net.isIP(candidate);
  if (family) {
    const host = candidate.toLowerCase();
    return {
      input,
      host,
      kind: `ipv${family}`,
      family,
      scope: classifyAddress(host, family),
      normalized_from_url: normalizedFromUrl,
      warnings,
    };
  }

  const withoutTrailingDot = candidate.endsWith('.') ? candidate.slice(0, -1) : candidate;
  const host = domainToASCII(withoutTrailingDot.toLowerCase());
  if (!host || host.length > 253 || host.includes('..')) {
    throw new ToolInputError('INVALID_HOSTNAME', 'Hostname is malformed.');
  }
  const labels = host.split('.');
  const labelPattern = allowUnderscore
    ? /^(?!-)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i
    : /^(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
  if (labels.some(label => label.length > 63 || !labelPattern.test(label))) {
    throw new ToolInputError('INVALID_HOSTNAME', 'Hostname contains an invalid label.');
  }

  return {
    input,
    host,
    kind: 'hostname',
    family: 0,
    scope: classifyAddress(host, 0),
    normalized_from_url: normalizedFromUrl,
    warnings,
  };
}

function createRequestId() {
  return crypto.randomUUID();
}

function createOperationLimiter(options = {}) {
  const globalLimit = Math.max(1, Number(options.globalLimit) || 4);
  const perToolLimit = { ...options.perToolLimit };
  let activeGlobal = 0;
  const activeByTool = new Map();

  function acquire(tool) {
    const activeTool = activeByTool.get(tool) || 0;
    const toolLimit = Math.max(1, Number(perToolLimit[tool]) || globalLimit);
    if (activeGlobal >= globalLimit || activeTool >= toolLimit) return null;

    activeGlobal += 1;
    activeByTool.set(tool, activeTool + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeGlobal = Math.max(0, activeGlobal - 1);
      const next = Math.max(0, (activeByTool.get(tool) || 1) - 1);
      if (next) activeByTool.set(tool, next);
      else activeByTool.delete(tool);
    };
  }

  function snapshot() {
    return { activeGlobal, activeByTool: Object.fromEntries(activeByTool) };
  }

  return { acquire, snapshot };
}

function runCommand(command, args = [], options = {}) {
  const {
    timeoutMs = 30000,
    maxBuffer = DEFAULT_MAX_BUFFER,
    signal,
  } = options;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let spawnError = null;
    let settled = false;
    let forceKillTimer = null;

    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const append = (current, chunk) => {
      if (current.length >= maxBuffer) {
        truncated = true;
        return current;
      }
      const remaining = maxBuffer - current.length;
      const value = chunk.toString('utf8');
      if (value.length > remaining) truncated = true;
      return current + value.slice(0, remaining);
    };

    const stopChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 250);
      forceKillTimer.unref?.();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, Math.max(1, timeoutMs));
    timeout.unref?.();

    const onAbort = () => {
      aborted = true;
      stopChild();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = append(stderr, chunk); });
    child.once('error', error => { spawnError = error; });
    child.once('close', (exitCode, childSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', onAbort);

      const durationMs = Date.now() - startedAt;
      resolve({
        ok: !spawnError && !timedOut && !aborted && exitCode === 0,
        command,
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: childSignal || null,
        timedOut,
        aborted,
        truncated,
        durationMs,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        errorCode: spawnError?.code || null,
        error: spawnError?.message || null,
      });
    });
  });
}

function commandOutput(result) {
  return [result.stdout, result.stderr, result.error].filter(Boolean).join('\n').trim();
}

function publicExecution(result, provider) {
  return {
    provider,
    exit_code: result.exitCode,
    signal: result.signal,
    timed_out: result.timedOut,
    aborted: result.aborted,
    truncated: result.truncated,
    duration_ms: result.durationMs,
    error_code: result.errorCode,
  };
}

function toolEnvelope({
  requestId,
  tool,
  ok,
  status = 'complete',
  target,
  diagnosis,
  durationMs,
  timedOut,
  execution = null,
  output = '',
  warnings = [],
  data = {},
}) {
  return {
    schema_version: 2,
    request_id: requestId || createRequestId(),
    tool,
    ok: Boolean(ok),
    status,
    target,
    diagnosis,
    duration_ms: durationMs,
    timed_out: timedOut == null ? Boolean(execution?.timed_out) : Boolean(timedOut),
    warnings,
    execution,
    output,
    ...data,
  };
}

module.exports = {
  ToolInputError,
  classifyAddress,
  commandOutput,
  createOperationLimiter,
  createRequestId,
  normalizeTarget,
  publicExecution,
  runCommand,
  toolEnvelope,
};
