// Tools - Network, SSL, Cron, Backup
(function() {
  const requestState = new Map();
  const toolConfig = {
    ping: {
      input: 'pingHost', run: 'pingRun', cancel: 'pingCancel', state: 'pingState', badge: 'pingBadge', meta: 'pingMeta', summary: 'pingSummary', output: 'pingResult',
      diagnosisAction: 'pingDiagnosisAction',
      request: () => ({ url: '/api/tools/v2/ping', body: { target: value('pingHost'), count: Number(value('pingCount')) } }),
      running: 'Sending ICMP probes',
    },
    traceroute: {
      input: 'traceHost', run: 'traceRun', cancel: 'traceCancel', state: 'traceState', badge: 'traceBadge', meta: 'traceMeta', summary: 'traceSummary', output: 'traceResult',
      diagnosisAction: 'traceDiagnosisAction',
      request: () => ({ url: '/api/tools/v2/trace', body: { target: value('traceHost'), max_hops: Number(value('traceHops')) } }),
      running: 'Tracing route',
    },
    dns: {
      input: 'dnsHost', run: 'dnsRun', cancel: 'dnsCancel', state: 'dnsState', badge: 'dnsBadge', meta: 'dnsMeta', summary: 'dnsSummary', output: 'dnsResult',
      request: () => ({ url: '/api/tools/v2/dns', body: { target: value('dnsHost'), type: value('dnsType') } }),
      running: 'Querying resolver',
    },
    portscan: {
      input: 'portHost', run: 'portRun', cancel: 'portCancel', state: 'portState', badge: 'portBadge', meta: 'portMeta', summary: 'portSummary', output: 'portResult',
      request: () => ({ url: '/api/tools/v2/port-scan', body: { target: value('portHost'), ports: value('portList') } }),
      running: 'Checking TCP ports',
    },
    diagnose: {
      input: 'diagnoseHost', run: 'diagnoseRun', cancel: 'diagnoseCancel', state: 'diagnoseState', badge: 'diagnoseBadge', meta: 'diagnoseMeta', summary: 'diagnoseSummary', output: 'diagnoseResult',
      request: () => ({ url: '/api/tools/v2/diagnose', body: { target: value('diagnoseHost'), include_trace: checked('diagnoseTrace'), max_hops: 12 } }),
      running: 'Building the reachability evidence ladder',
    },
  };

  function value(id) {
    return document.getElementById(id)?.value?.trim() || '';
  }

  function checked(id) {
    return Boolean(document.getElementById(id)?.checked);
  }

  function setText(id, text) {
    const element = document.getElementById(id);
    if (element) element.textContent = text || '';
  }

  function normalizeState(severity) {
    if (['healthy', 'success', 'normal'].includes(severity)) return 'success';
    if (['warning', 'attention', 'neutral'].includes(severity)) return 'warning';
    return severity === 'error' ? 'error' : 'success';
  }

  function setCardState(config, state, badge, meta, summary) {
    const stateElement = document.getElementById(config.state);
    const card = stateElement?.closest('[data-tool-card]');
    if (stateElement) stateElement.dataset.state = state;
    if (card) card.dataset.state = state;
    setText(config.badge, badge);
    setText(config.meta, meta);
    setText(config.summary, summary);
  }

  function setBusy(config, busy) {
    const stateElement = document.getElementById(config.state);
    const card = stateElement?.closest('[data-tool-card]');
    card?.querySelectorAll('input, select').forEach(control => { control.disabled = busy; });
    const runButton = document.getElementById(config.run);
    const cancelButton = document.getElementById(config.cancel);
    if (runButton) {
      runButton.disabled = busy;
      runButton.setAttribute('aria-busy', String(busy));
    }
    if (cancelButton) cancelButton.hidden = !busy;
    if (config === toolConfig.diagnose) {
      document.querySelectorAll('[data-send-to-diagnosis]').forEach(button => { button.disabled = busy; });
    }
  }

  function clearRequestTimer(state) {
    if (state?.timer == null) return;
    window.clearInterval(state.timer);
    state.timer = null;
  }

  function metadataToken(value, maxLength = 40) {
    return String(value == null ? '' : value).trim().slice(0, maxLength);
  }

  function traceExecutionMeta(payload) {
    const data = payload?.data || {};
    const trace = data.trace || payload?.trace || {};
    const execution = payload?.execution || data.execution || {};
    const provider = metadataToken(data.provider || trace.provider || execution.provider);
    const transport = metadataToken(data.transport || trace.transport || execution.transport).toUpperCase();
    const rawPort = data.port ?? trace.port ?? execution.port;
    const port = Number(rawPort);
    const endpoint = transport
      ? `${transport}${Number.isInteger(port) && port > 0 ? ` ${port}` : ''}`
      : Number.isInteger(port) && port > 0 ? `Port ${port}` : '';
    return [provider, endpoint].filter(Boolean).join(' · ');
  }

  function payloadOutput(tool, payload) {
    if (tool === 'dns' && Array.isArray(payload.result)) return payload.result.join('\n');
    if (tool === 'portscan' && Array.isArray(payload.ports)) {
      return payload.ports.map(item => `Port ${item.port}: ${item.status}${item.latency_ms != null ? ` (${item.latency_ms} ms)` : ''}`).join('\n');
    }
    const output = payload.output || payload.error || '';
    const traceMeta = tool === 'traceroute' ? traceExecutionMeta(payload) : '';
    return traceMeta ? [`Trace mode: ${traceMeta}`, output].filter(Boolean).join('\n') : output;
  }

  function payloadWarningText(payload) {
    const labels = {
      URL_NORMALIZED_TO_HOST: 'The URL was normalized to its hostname.',
      URL_PORT_IGNORED: 'The URL port was ignored; use the tool-specific port controls instead.',
      URL_PATH_IGNORED: 'The URL path, query, and fragment were ignored.',
    };
    const warnings = Array.isArray(payload?.warnings) ? payload.warnings : [];
    return warnings.map(warning => labels[warning] || String(warning)).join(' ');
  }

  function renderDiagnosisStages(payload) {
    const container = document.getElementById('diagnoseStages');
    if (!container) return;
    container.replaceChildren();
    const labels = { dns: 'DNS', tcp: 'TCP', tls: 'TLS', http: 'HTTP', icmp: 'ICMP', trace: 'Trace' };
    for (const stage of Array.isArray(payload?.stages) ? payload.stages : []) {
      const item = document.createElement('li');
      item.className = 'diagnosis-stage';
      item.dataset.state = stage.state || 'skipped';
      const name = document.createElement('span');
      name.className = 'diagnosis-stage-name';
      name.textContent = labels[stage.id] || stage.id || 'Stage';
      const code = document.createElement('span');
      code.className = 'diagnosis-stage-code';
      code.textContent = stage.code || 'UNKNOWN';
      const summary = document.createElement('span');
      summary.className = 'diagnosis-stage-summary';
      summary.textContent = stage.summary || 'No evidence.';
      item.append(name, code, summary);
      container.appendChild(item);
    }
  }

  function isUrlInput(target) {
    try {
      const parsed = new URL(target);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (_) {
      return false;
    }
  }

  function hideDiagnosisAction(config) {
    const action = config?.diagnosisAction && document.getElementById(config.diagnosisAction);
    if (!action) return;
    action.hidden = true;
    const button = action.querySelector('[data-send-to-diagnosis]');
    if (button) delete button.dataset.target;
  }

  function showDiagnosisAction(tool, config, target) {
    const action = config?.diagnosisAction && document.getElementById(config.diagnosisAction);
    const button = action?.querySelector('[data-send-to-diagnosis]');
    if (!action || !button || !isUrlInput(target)) {
      hideDiagnosisAction(config);
      return;
    }
    button.dataset.target = target;
    button.disabled = requestState.has('diagnose');
    button.setAttribute('aria-label', `Use ${tool === 'traceroute' ? 'Traceroute' : 'Ping'} URL in Unified Network Diagnosis`);
    action.hidden = false;
  }

  function prepareDiagnosis(source, target) {
    const config = toolConfig.diagnose;
    const input = document.getElementById(config.input);
    const card = input?.closest('[data-tool-card="diagnose"]');
    if (!input || !card || !isUrlInput(target) || requestState.has('diagnose')) return;

    input.value = target;
    card.dataset.prepared = 'true';
    setText(config.output, '');
    document.getElementById('diagnoseStages')?.replaceChildren();
    document.getElementById('diagnoseRaw')?.removeAttribute('open');
    setCardState(
      config,
      'idle',
      'Ready',
      source === 'traceroute' ? 'From Traceroute' : 'From Ping',
      'URL copied. Review the traceroute option, then run the diagnosis explicitly.'
    );

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    card.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
    window.requestAnimationFrame(() => input.focus({ preventScroll: true }));
  }

  function renderPayload(tool, config, payload, httpStatus, target) {
    const diagnosis = payload?.diagnosis || {};
    const severity = diagnosis.severity || (httpStatus >= 400 ? 'error' : payload?.ok === false ? 'warning' : 'healthy');
    const state = normalizeState(severity);
    const code = diagnosis.code || (httpStatus >= 400 ? `HTTP_${httpStatus}` : 'COMPLETE');
    const duration = Number(payload?.duration_ms);
    const executionMeta = tool === 'traceroute' ? traceExecutionMeta(payload) : '';
    const meta = [Number.isFinite(duration) ? `${duration} ms` : '', code, executionMeta].filter(Boolean).join(' · ');
    const baseSummary = diagnosis.summary || payload?.error || 'Diagnostic completed.';
    const warningText = payloadWarningText(payload);
    const summary = warningText ? `${baseSummary} Note: ${warningText}` : baseSummary;
    setCardState(config, state, state === 'success' ? 'Complete' : state === 'warning' ? 'Review' : 'Error', meta, summary);
    setText(config.output, payloadOutput(tool, payload));
    if (tool === 'diagnose') renderDiagnosisStages(payload);
    else showDiagnosisAction(tool, config, target);
  }

  async function executeTool(tool) {
    const config = toolConfig[tool];
    const target = config ? value(config.input) : '';
    hideDiagnosisAction(config);
    if (!config || !target) {
      if (config) setCardState(config, 'error', 'Input', 'INVALID_TARGET', 'Enter a hostname, IP address, or URL.');
      return;
    }

    if (tool === 'diagnose') {
      document.getElementById(config.input)?.closest('[data-tool-card="diagnose"]')?.removeAttribute('data-prepared');
    }

    const previous = requestState.get(tool);
    if (previous) {
      clearRequestTimer(previous);
      previous.controller.abort();
    }
    const sequence = (previous?.sequence || 0) + 1;
    const controller = new AbortController();
    const startedAt = performance.now();
    const state = { controller, sequence, timer: null, cancelled: false, target };
    requestState.set(tool, state);
    setBusy(config, true);
    setText(config.output, '');
    if (tool === 'diagnose') document.getElementById('diagnoseStages')?.replaceChildren();
    setCardState(config, 'running', 'Running', '0.0 s', `${config.running} from this VPS...`);

    state.timer = window.setInterval(() => {
      if (requestState.get(tool)?.sequence !== sequence) return;
      setText(config.meta, `${((performance.now() - startedAt) / 1000).toFixed(1)} s elapsed`);
    }, 200);

    try {
      const descriptor = config.request ? config.request() : { url: config.url(), body: null };
      const response = await fetch(descriptor.url, {
        method: descriptor.body ? 'POST' : 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(descriptor.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: descriptor.body ? JSON.stringify(descriptor.body) : undefined,
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => ({
        ok: false,
        error: `HTTP ${response.status}: invalid JSON response`,
        diagnosis: { code: 'INVALID_RESPONSE', severity: 'error', summary: 'Server returned an invalid response.' },
      }));
      if (requestState.get(tool)?.sequence !== sequence) return;
      renderPayload(tool, config, payload, response.status, state.target);
    } catch (error) {
      if (requestState.get(tool)?.sequence !== sequence) return;
      if (error.name === 'AbortError') {
        state.cancelled = true;
        setCardState(config, 'cancelled', 'Cancelled', 'CLIENT_ABORTED', 'Diagnostic cancelled. Backend cleanup was requested.');
        setText(config.output, '');
      } else {
        setCardState(config, 'error', 'Error', 'REQUEST_FAILED', error.message || 'Diagnostic request failed.');
      }
    } finally {
      clearRequestTimer(state);
      if (requestState.get(tool)?.sequence === sequence) {
        setBusy(config, false);
        if (state.cancelled) document.getElementById(config.run)?.focus();
        requestState.delete(tool);
      }
    }
  }

  function cancelTool(tool) {
    requestState.get(tool)?.controller.abort();
  }

  for (const [tool, config] of Object.entries(toolConfig)) {
    const input = document.getElementById(config.input);
    document.getElementById(config.run)?.addEventListener('click', () => executeTool(tool));
    document.getElementById(config.cancel)?.addEventListener('click', () => cancelTool(tool));
    input?.addEventListener('input', () => hideDiagnosisAction(config));
    input?.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        executeTool(tool);
      }
    });
  }

  document.querySelectorAll('[data-send-to-diagnosis]').forEach(button => {
    button.addEventListener('click', () => prepareDiagnosis(button.dataset.sendToDiagnosis, button.dataset.target || ''));
  });
  document.getElementById('diagnoseHost')?.addEventListener('input', event => {
    event.currentTarget.closest('[data-tool-card="diagnose"]')?.removeAttribute('data-prepared');
  });

  async function loadSSL() {
    try {
      const res = await fetch('/api/ssl');
      const certs = await res.json();
      const container = document.getElementById('sslCerts');
      container.innerHTML = certs.map(c => {
        if (c.error) return `<div class="stat-row"><span class="stat-label">${c.domain}</span><span style="color:var(--red)">${c.error}</span></div>`;
        const color = c.daysLeft < 7 ? 'var(--red)' : c.daysLeft < 30 ? 'var(--yellow)' : 'var(--accent)';
        return `
          <div class="stat-row">
            <span class="stat-label">${c.domain}</span>
            <span style="color:${color};font-weight:600">${c.daysLeft} days left</span>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;padding-left:12px">
            Issuer: ${c.issuer} | Expires: ${new Date(c.validTo).toLocaleDateString('id-ID')}
          </div>
        `;
      }).join('');
    } catch (err) {
      document.getElementById('sslCerts').textContent = `Error: ${err.message}`;
    }
  }

  async function loadCron() {
    try {
      const res = await fetch('/api/cron');
      const data = await res.json();
      const container = document.getElementById('cronJobs');
      let output = '=== User Crontab ===\n' + (data.user || 'No crontab') + '\n\n';
      output += '=== System Crontab ===\n' + (data.system || 'Empty') + '\n';
      if (data.cronD && data.cronD.length) {
        output += '\n=== /etc/cron.d/ ===\n';
        for (const f of data.cronD) output += `\n--- ${f.file} ---\n${f.content}\n`;
      }
      container.textContent = output;
    } catch (err) {
      document.getElementById('cronJobs').textContent = `Error: ${err.message}`;
    }
  }

  async function loadBackups() {
    const res = await fetch('/api/backups');
    const backups = await res.json();
    const container = document.getElementById('backupList');
    if (backups.length === 0) {
      container.innerHTML = '<p class="empty-state">No backups yet</p>';
      return;
    }
    container.innerHTML = backups.map(b => `
      <div class="stat-row" style="padding:8px 0;border-bottom:1px solid var(--border-light)">
        <span class="stat-label">${b.name}</span>
        <span style="font-size:12px;color:var(--text-muted)">${formatBytes(b.size)}</span>
        <span style="font-size:11px;color:var(--text-muted)">${new Date(b.created).toLocaleString('id-ID')}</span>
        <button class="proc-btn danger" onclick="window.deleteBackup('${b.name}')">Delete</button>
      </div>
    `).join('');
  }

  async function createBackup() {
    const res = await fetch('/api/backups/create', { method: 'POST' });
    const data = await res.json();
    if (data.ok) { window.showToast('Backup created'); loadBackups(); }
    else window.showToast('Error: ' + data.error, true);
  }

  async function deleteBackup(name) {
    window.showConfirm('Delete backup?', name, async () => {
      await fetch('/api/backups/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      window.showToast('Backup deleted');
      loadBackups();
    });
  }

  window.runPing = () => executeTool('ping');
  window.runTraceroute = () => executeTool('traceroute');
  window.runDns = () => executeTool('dns');
  window.runPortscan = () => executeTool('portscan');
  window.runNetworkDiagnosis = () => executeTool('diagnose');
  window.cancelNetworkTool = cancelTool;
  window.networkToolRequests = requestState;
  window.loadTools = function() { loadSSL(); loadCron(); loadBackups(); };
  window.createBackup = createBackup;
  window.deleteBackup = deleteBackup;
})();
