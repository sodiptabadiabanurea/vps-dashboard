// Process manager and top-process sample diff
(function() {
  'use strict';

  let allProcesses = [];
  let latestDiff = null;

  function text(value, fallback = '') {
    if (value == null) return fallback;
    return String(value).slice(0, 240);
  }

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function processKey(process) {
    return `${Math.trunc(number(process?.pid))}:${text(process?.name, 'unknown')}`;
  }

  function normalizeProcess(process) {
    const source = process && typeof process === 'object' ? process : {};
    return {
      pid: Math.trunc(number(source.pid)),
      name: text(source.name, 'unknown'),
      cmd: text(source.cmd, ''),
      cpu: number(source.cpu),
      mem: number(source.mem),
      rss: number(source.rss),
      state: text(source.state, 'Unknown'),
      uptime: text(source.uptime, '-'),
    };
  }

  function normalizeDiffRows(rows) {
    return Array.isArray(rows) ? rows.map(normalizeProcess) : [];
  }

  function normalizeDiff(diff) {
    if (!diff || typeof diff !== 'object') return null;

    const normalizeCpuSpikes = (rows) => (Array.isArray(rows) ? rows : []).map(row => ({
      ...normalizeProcess(row),
      delta_cpu: number(row?.delta_cpu),
      previous_cpu: number(row?.previous_cpu),
    }));
    const normalizeMemorySpikes = (rows) => (Array.isArray(rows) ? rows : []).map(row => ({
      ...normalizeProcess(row),
      delta_rss: number(row?.delta_rss),
      delta_mem: number(row?.delta_mem),
      previous_rss: number(row?.previous_rss),
    }));

    const entered = normalizeDiffRows(diff.entered);
    const left = normalizeDiffRows(diff.left);
    const cpuSpikes = normalizeCpuSpikes(diff.cpu_spikes);
    const memorySpikes = normalizeMemorySpikes(diff.memory_spikes);
    const counts = diff.counts && typeof diff.counts === 'object' ? diff.counts : {};
    return {
      observed_at: number(diff.observed_at),
      scope: text(diff.scope, 'top-process-sample'),
      baseline: Boolean(diff.baseline),
      counts: {
        entered: Math.max(0, Math.trunc(number(counts.entered, entered.length))),
        left: Math.max(0, Math.trunc(number(counts.left, left.length))),
        cpu_spikes: Math.max(0, Math.trunc(number(counts.cpu_spikes, cpuSpikes.length))),
        memory_spikes: Math.max(0, Math.trunc(number(counts.memory_spikes, memorySpikes.length))),
      },
      entered,
      left,
      cpu_spikes: cpuSpikes,
      memory_spikes: memorySpikes,
    };
  }

  function createCell(className) {
    const cell = document.createElement('td');
    if (className) cell.className = className;
    return cell;
  }

  function formatPercent(value) {
    return `${number(value).toFixed(1).replace(/\.0$/, '')}%`;
  }

  function formatMemory(bytes) {
    const safeBytes = Math.max(0, number(bytes));
    if (typeof window.formatBytes === 'function') {
      return text(window.formatBytes(safeBytes), '0 B');
    }
    return `${(safeBytes / 1024 / 1024).toFixed(0)} MB`;
  }

  function formatSignedMemory(bytes) {
    const value = number(bytes);
    const sign = value >= 0 ? '+' : '-';
    return `${sign}${formatMemory(Math.abs(value))}`;
  }

  function findDiffRows(process) {
    if (!latestDiff) return { entered: false, cpu: null, memory: null };
    const key = processKey(process);
    return {
      entered: latestDiff.entered.some(row => processKey(row) === key),
      cpu: latestDiff.cpu_spikes.find(row => processKey(row) === key) || null,
      memory: latestDiff.memory_spikes.find(row => processKey(row) === key) || null,
    };
  }

  function appendDeltaChip(container, label, className, title) {
    const chip = document.createElement('span');
    chip.className = `process-delta-chip ${className}`;
    chip.textContent = label;
    if (title) chip.title = title;
    container.appendChild(chip);
  }

  function renderDeltaCell(process) {
    const cell = createCell('proc-delta');
    const changes = findDiffRows(process);

    if (!latestDiff) {
      appendDeltaChip(cell, 'Waiting', 'is-neutral', 'Waiting for two process samples');
      return cell;
    }

    if (latestDiff.baseline) {
      appendDeltaChip(cell, 'Baseline', 'is-neutral', 'First top-process sample; no comparison yet');
      return cell;
    }

    if (changes.entered) {
      appendDeltaChip(
        cell,
        'Entered sample',
        'is-entered',
        'Entered the monitored top-process sample; this does not prove the process just started'
      );
    }
    if (changes.cpu) {
      appendDeltaChip(
        cell,
        `CPU +${number(changes.cpu.delta_cpu).toFixed(1).replace(/\.0$/, '')} pts`,
        'is-hot',
        `CPU moved from ${formatPercent(changes.cpu.previous_cpu)} to ${formatPercent(changes.cpu.cpu)}`
      );
    }
    if (changes.memory) {
      const rssDelta = number(changes.memory.delta_rss);
      const label = rssDelta !== 0
        ? `RSS ${formatSignedMemory(rssDelta)}`
        : `MEM +${number(changes.memory.delta_mem).toFixed(1).replace(/\.0$/, '')} pts`;
      appendDeltaChip(cell, label, 'is-hot', 'Memory increased materially between top-process samples');
    }

    if (!cell.childElementCount) {
      appendDeltaChip(cell, 'Stable', 'is-stable', 'No material sample-to-sample change detected');
    }
    return cell;
  }

  function stateClass(state) {
    const value = text(state, 'unknown').toLowerCase().replace(/\s+/g, '');
    return ['running', 'sleeping', 'zombie', 'stopped'].includes(value) ? value : 'unknown';
  }

  function renderProcessRow(process) {
    const row = document.createElement('tr');

    const pid = createCell('proc-pid');
    pid.textContent = String(process.pid);
    row.appendChild(pid);

    const processCell = createCell();
    const name = document.createElement('span');
    name.className = 'proc-name';
    name.textContent = process.name;
    if (process.cmd) name.title = process.cmd;
    processCell.appendChild(name);
    row.appendChild(processCell);

    const cpu = createCell('proc-cpu');
    cpu.textContent = formatPercent(process.cpu);
    row.appendChild(cpu);

    const mem = createCell('proc-mem');
    mem.textContent = formatPercent(process.mem);
    row.appendChild(mem);

    const rss = createCell('proc-mem');
    rss.textContent = formatMemory(process.rss);
    row.appendChild(rss);

    row.appendChild(renderDeltaCell(process));

    const status = createCell();
    const statusLabel = document.createElement('span');
    statusLabel.className = `proc-status ${stateClass(process.state)}`;
    statusLabel.textContent = process.state;
    status.appendChild(statusLabel);
    row.appendChild(status);

    const uptime = createCell('proc-uptime');
    uptime.textContent = process.uptime;
    row.appendChild(uptime);

    const actions = createCell();
    const actionGroup = document.createElement('div');
    actionGroup.className = 'proc-actions full';

    const killButton = document.createElement('button');
    killButton.type = 'button';
    killButton.className = 'proc-btn';
    killButton.textContent = 'Kill';
    killButton.title = 'Kill (SIGTERM)';
    killButton.addEventListener('click', () => window.killProcess(process.pid, process.name, false));

    const forceButton = document.createElement('button');
    forceButton.type = 'button';
    forceButton.className = 'proc-btn danger';
    forceButton.textContent = 'Force';
    forceButton.title = 'Force kill (SIGKILL)';
    forceButton.addEventListener('click', () => window.killProcess(process.pid, process.name, true));

    actionGroup.append(killButton, forceButton);
    actions.appendChild(actionGroup);
    row.appendChild(actions);
    return row;
  }

  function processTableBody() {
    return document.getElementById('processesTableBody') || document.getElementById('procFull');
  }

  function renderProcessTable() {
    const body = processTableBody();
    if (!body) return;

    const search = text(document.getElementById('procSearch')?.value).toLowerCase();
    const sortBy = document.getElementById('procSort')?.value || 'cpu';
    const filtered = allProcesses.filter(process => (
      process.name.toLowerCase().includes(search) ||
      process.cmd.toLowerCase().includes(search) ||
      String(process.pid).includes(search)
    ));

    filtered.sort((a, b) => {
      if (sortBy === 'cpu') return b.cpu - a.cpu;
      if (sortBy === 'mem') return b.mem - a.mem;
      if (sortBy === 'pid') return a.pid - b.pid;
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      return 0;
    });

    const fragment = document.createDocumentFragment();
    filtered.forEach(process => fragment.appendChild(renderProcessRow(process)));
    body.replaceChildren(fragment);
  }

  function sampleNames(rows) {
    return rows.slice(0, 3).map(row => `${row.name} (${row.pid})`).join(', ');
  }

  function renderDiffSummary() {
    const summary = document.getElementById('processDiffSummary');
    const details = document.getElementById('processDiffDetails');
    const scope = document.getElementById('processDiffScope');
    if (!summary && !details) return;

    if (scope) scope.textContent = 'Top-process sample';

    if (!latestDiff) {
      if (summary) summary.textContent = 'Waiting for the process comparison stream.';
      details?.replaceChildren();
      return;
    }

    if (latestDiff.baseline) {
      if (summary) summary.textContent = 'Baseline captured. Changes will appear after the next top-process sample.';
      details?.replaceChildren();
      return;
    }

    const total = latestDiff.counts.entered + latestDiff.counts.left + latestDiff.counts.cpu_spikes + latestDiff.counts.memory_spikes;
    if (summary) {
      summary.textContent = total === 0
        ? 'No material change between the latest top-process samples.'
        : `${total} material ${total === 1 ? 'change' : 'changes'} detected. Entered and left describe sample membership, not process start or stop.`;
    }
    if (!details) return;

    const fragment = document.createDocumentFragment();
    [
      ['Entered sample', latestDiff.counts.entered, 'is-entered'],
      ['Left sample', latestDiff.counts.left, 'is-left'],
      ['CPU jumps', latestDiff.counts.cpu_spikes, 'is-hot'],
      ['Memory jumps', latestDiff.counts.memory_spikes, 'is-hot'],
    ].forEach(([label, count, className]) => {
      const stat = document.createElement('div');
      stat.className = `process-diff-stat ${className}`;
      const value = document.createElement('strong');
      value.textContent = String(count);
      const copy = document.createElement('span');
      copy.textContent = label;
      stat.append(value, copy);
      fragment.appendChild(stat);
    });

    if (latestDiff.left.length) {
      const left = document.createElement('p');
      left.className = 'process-diff-detail';
      left.textContent = `Left the sample: ${sampleNames(latestDiff.left)}`;
      fragment.appendChild(left);
    }
    if (latestDiff.entered.length) {
      const entered = document.createElement('p');
      entered.className = 'process-diff-detail';
      entered.textContent = `Entered the sample: ${sampleNames(latestDiff.entered)}`;
      fragment.appendChild(entered);
    }

    details.replaceChildren(fragment);
  }

  function applyProcessDiff(diff) {
    const payload = diff?.snapshot || diff;
    const candidate = payload?.process_diff || payload;
    const looksLikeDiff = candidate && typeof candidate === 'object' && (
      'baseline' in candidate ||
      'entered' in candidate ||
      'left' in candidate ||
      'cpu_spikes' in candidate ||
      'memory_spikes' in candidate
    );
    if (!looksLikeDiff) return;
    const normalized = normalizeDiff(candidate);
    if (!normalized) return;
    if (latestDiff?.observed_at && normalized.observed_at && normalized.observed_at <= latestDiff.observed_at) return;
    latestDiff = normalized;
    renderDiffSummary();
    renderProcessTable();
  }

  if (window.socket && typeof window.socket.on === 'function') {
    window.socket.on('processes', processes => {
      allProcesses = Array.isArray(processes) ? processes.map(normalizeProcess) : [];
      renderProcessTable();
    });
    window.socket.on('process-diff', applyProcessDiff);
    window.socket.on('mission-state', payload => {
      if (payload?.process_diff) applyProcessDiff(payload.process_diff);
    });
  }

  ['mission-control:snapshot', 'mission-control-snapshot', 'mission-control:update', 'vps:mission-snapshot'].forEach(eventName => {
    window.addEventListener(eventName, event => applyProcessDiff(event.detail));
    document.addEventListener(eventName, event => applyProcessDiff(event.detail));
  });
  document.addEventListener('vps:processdiff', event => applyProcessDiff(event.detail));
  document.addEventListener('vps:missionupdate', event => applyProcessDiff(event.detail));

  document.getElementById('procSearch')?.addEventListener('input', renderProcessTable);
  document.getElementById('procSort')?.addEventListener('change', renderProcessTable);

  window.updateProcessDiff = applyProcessDiff;
  window.killProcess = function(pid, name, force) {
    const safePid = Math.trunc(number(pid));
    if (safePid <= 0) {
      window.showToast?.('Invalid process ID', true);
      return;
    }

    const processName = text(name, 'unknown');
    window.showConfirm(
      `Kill ${processName} (PID ${safePid})?`,
      force ? 'This will forcefully terminate the process (SIGKILL).' : 'This will send SIGTERM to the process.',
      async () => {
        try {
          const endpoint = force ? 'kill-force' : 'kill';
          const response = await fetch(`/api/processes/${safePid}/${endpoint}`, { method: 'POST' });
          const data = await response.json();
          if (response.ok && data.ok) {
            window.showToast?.(`Process ${safePid} terminated`);
          } else {
            window.showToast?.(`Error: ${text(data.error, 'Request failed')}`, true);
          }
        } catch (error) {
          window.showToast?.(`Error: ${text(error.message, 'Request failed')}`, true);
        }
      }
    );
  };

  if (window.missionProcessDiff) applyProcessDiff(window.missionProcessDiff);
  else if (window.missionControlSnapshot?.process_diff) applyProcessDiff(window.missionControlSnapshot.process_diff);
  else renderDiffSummary();
})();
