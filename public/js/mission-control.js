// Mission Control operational layer: state, evidence, and accessible explanations.
(function() {
  'use strict';

  const VALID_LEVELS = new Set(['healthy', 'attention', 'incident', 'offline']);
  const VALID_TONES = new Set(['normal', 'neutral', 'attention', 'incident']);
  const VALID_PHASES = new Set(['change', 'trigger', 'impact', 'recovery', 'context']);
  const state = {
    snapshot: null,
    receivedAt: 0,
    refreshTimer: null,
    refreshDueAt: 0,
    freshnessTimer: null,
    fetchController: null,
    lastFetchAt: 0,
    lastFetchAttemptAt: 0,
    lastProcessDiffAt: 0,
    lastAnnouncedLevel: null,
    causalSignature: '',
    clientStale: false,
    drawerMetric: null,
    drawerOpener: null,
    inertElements: [],
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function setText(target, value) {
    const element = typeof target === 'string' ? byId(target) : target;
    if (!element) return;
    const nextValue = String(value == null ? '' : value);
    if (element.textContent !== nextValue) element.textContent = nextValue;
  }

  function clear(element) {
    if (element) element.replaceChildren();
  }

  function createElement(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content != null) element.textContent = String(content);
    return element;
  }

  function finite(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function toMilliseconds(value) {
    const number = finite(value);
    if (number == null || number <= 0) return null;
    return number < 1e12 ? number * 1000 : number;
  }

  function optionalNumber(value) {
    if (value == null || value === '') return null;
    return finite(value);
  }

  function isOlderSnapshot(snapshot) {
    if (!state.snapshot) return false;
    const currentBootId = String(state.snapshot.boot_id || '');
    const nextBootId = String(snapshot?.boot_id || '');
    if (currentBootId && nextBootId && currentBootId !== nextBootId) {
      const currentGeneratedAt = toMilliseconds(state.snapshot.generated_at);
      const nextGeneratedAt = toMilliseconds(snapshot?.generated_at);
      return currentGeneratedAt != null && nextGeneratedAt != null && nextGeneratedAt < currentGeneratedAt;
    }
    const currentRevision = optionalNumber(state.snapshot.revision);
    const nextRevision = optionalNumber(snapshot?.revision);
    if (currentRevision != null && nextRevision != null) {
      if (nextRevision < currentRevision) return true;
      if (nextRevision > currentRevision) return false;
    }

    const currentGeneratedAt = toMilliseconds(state.snapshot.generated_at);
    const nextGeneratedAt = toMilliseconds(snapshot?.generated_at);
    return currentGeneratedAt != null && nextGeneratedAt != null && nextGeneratedAt < currentGeneratedAt;
  }

  function formatPercent(value) {
    const number = finite(value);
    if (number == null) return '—';
    return `${Math.round(number * 10) / 10}%`;
  }

  function formatCompactDuration(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    if (seconds < 10) return 'just now';
    if (seconds < 30) return 'under 30s';
    if (seconds < 60) return 'under 1m';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  }

  function formatEventAge(seconds) {
    const age = Math.max(0, finite(seconds, 0));
    if (age < 60) return 'now';
    if (age < 3600) return `${Math.floor(age / 60)}m ago`;
    if (age < 86400) return `${Math.floor(age / 3600)}h ago`;
    return `${Math.floor(age / 86400)}d ago`;
  }

  function normalizeLevel(value) {
    return VALID_LEVELS.has(value) ? value : 'offline';
  }

  function normalizeSnapshot(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    return payload.snapshot && typeof payload.snapshot === 'object'
      ? payload.snapshot
      : payload;
  }

  function currentExplanationKey() {
    const primary = state.snapshot?.primary_signal?.key;
    if (primary && state.snapshot?.explanations?.[primary]) return primary;
    if (primary === 'services') return 'services';
    if (primary === 'processes') return 'cpu';
    if ((state.snapshot?.inactive_services || []).length > 0) return 'services';
    return 'cpu';
  }

  function fallbackExplanation(metric) {
    const snapshot = state.snapshot || {};
    const label = metric === 'services' ? 'service health' : metric.toUpperCase();
    return {
      title: `Why is ${label} here?`,
      summary: snapshot.summary || 'A complete evidence snapshot is not available yet.',
      confidence: null,
      coverage_label: 'Evidence coverage pending',
      evidence: [
        { label: 'Current state', value: snapshot.status_label || 'Collecting', tone: snapshot.level === 'incident' ? 'incident' : 'neutral' },
      ],
      next_checks: [{ label: 'Open Dashboard', page: 'dashboard' }],
    };
  }

  function renderMissionState() {
    const snapshot = state.snapshot;
    if (!snapshot) return;
    state.clientStale = false;

    const level = normalizeLevel(snapshot.level);
    const now = byId('missionNow');
    const banner = byId('incidentBanner');
    const metrics = snapshot.metrics || {};
    const inactiveServices = Array.isArray(snapshot.inactive_services) ? snapshot.inactive_services : [];
    const unavailableSources = Array.isArray(snapshot.unavailable_sources) ? snapshot.unavailable_sources : [];

    if (now) now.dataset.level = level;
    document.body.dataset.missionLevel = level;
    setText('missionStateChip', snapshot.status_label || level);
    setText('missionWeather', snapshot.weather || 'Current state');
    setText('missionNowTitle', snapshot.headline || 'Operational picture unavailable');
    setText('missionNowSummary', snapshot.summary || 'Waiting for a complete snapshot.');
    setText('missionRecommendation', snapshot.recommendation || 'Wait for fresh evidence before taking action.');
    setText('missionMetricCpu', formatPercent(metrics.cpu));
    setText('missionMetricRam', formatPercent(metrics.ram));
    setText('missionMetricDisk', formatPercent(metrics.disk));
    setText(
      'missionMetricServices',
      level === 'offline' || unavailableSources.includes('services')
        ? 'Unknown'
        : inactiveServices.length > 0
          ? `${inactiveServices.length} inactive`
          : 'All active'
    );

    if (state.lastAnnouncedLevel !== level) {
      const announcement = level === 'healthy'
        ? `Mission Control recovered. ${snapshot.headline || 'Core systems are nominal.'}`
        : `${snapshot.status_label || level}. ${snapshot.headline || 'Operational state changed.'}`;
      setText('missionAnnouncement', announcement);
      state.lastAnnouncedLevel = level;
    }

    if (banner) {
      const shouldShow = level !== 'healthy';
      banner.hidden = !shouldShow;
      banner.dataset.level = level;
      if (shouldShow) {
        const labels = {
          attention: 'Attention mode',
          incident: 'Incident mode',
          offline: 'Telemetry offline',
        };
        setText('incidentBannerLabel', labels[level] || 'Mission status');
        setText('incidentBannerHeadline', snapshot.headline || 'Operational state needs attention');
        setText('incidentBannerSummary', snapshot.summary || snapshot.recommendation || 'Review the latest evidence.');
      }
    }

    renderFreshness();
    if (state.drawerMetric) renderDrawer(state.drawerMetric);
  }

  function nextFreshnessDelay(ageMs) {
    if (ageMs < 10000) return 10000 - ageMs;
    if (ageMs < 30000) return 30000 - ageMs;
    if (ageMs < 60000) return 60000 - ageMs;
    return 60000 - (ageMs % 60000);
  }

  function renderFreshness() {
    window.clearTimeout(state.freshnessTimer);
    if (!state.snapshot) return;

    const generatedAt = toMilliseconds(state.snapshot.generated_at) || state.receivedAt;
    const baseAge = Math.max(0, finite(state.snapshot.telemetry_age_ms, 0));
    const ageMs = Math.max(0, Date.now() - generatedAt + baseAge);
    const level = normalizeLevel(state.snapshot.level);
    if (ageMs > 45000) {
      const staleFor = formatCompactDuration(ageMs);
      const now = byId('missionNow');
      const banner = byId('incidentBanner');
      if (now) now.dataset.level = 'offline';
      document.body.dataset.missionLevel = 'offline';
      setText('missionStateChip', 'Offline');
      setText('missionWeather', 'Client view stale');
      setText('missionNowTitle', 'Live Mission Control connection is stale');
      setText('missionNowSummary', `No fresh socket or HTTP snapshot has arrived for ${staleFor}. Last-known values are hidden until reconnection.`);
      setText('missionRecommendation', 'Check connectivity and reload only after the live connection returns.');
      setText('missionMetricCpu', '—');
      setText('missionMetricRam', '—');
      setText('missionMetricDisk', '—');
      setText('missionMetricServices', 'Unknown');
      setText('missionFreshness', `Stale · ${staleFor}`);
      if (banner) {
        banner.hidden = false;
        banner.dataset.level = 'offline';
        setText('incidentBannerLabel', 'Connection stale');
        setText('incidentBannerHeadline', 'Mission Control stopped receiving fresh state');
        setText('incidentBannerSummary', 'Displayed operational claims are suspended until telemetry reconnects.');
        setText('incidentDuration', `Stale for ${staleFor}`);
      }
      if (!state.clientStale) setText('missionAnnouncement', 'Mission Control connection is stale. Current operational state is unknown.');
      state.clientStale = true;
      scheduleRefresh({ minInterval: 30000 });
      state.freshnessTimer = window.setTimeout(renderFreshness, 5000);
      return;
    }
    const prefix = level === 'offline' ? 'Telemetry' : ageMs < 10000 ? 'Live' : ageMs < 30000 ? 'Fresh' : 'Updated';
    setText('missionFreshness', `${prefix} · ${formatCompactDuration(ageMs)}`);

    const incidentSince = toMilliseconds(state.snapshot.incident_since);
    if (level !== 'healthy' && incidentSince) {
      setText('incidentDuration', `Active for ${formatCompactDuration(Date.now() - incidentSince)}`);
    } else {
      setText('incidentDuration', 'Just detected');
    }

    const delay = Math.max(500, Math.min(nextFreshnessDelay(ageMs), 60000));
    state.freshnessTimer = window.setTimeout(renderFreshness, delay);
  }

  function appendChange(list, kind, title, detail) {
    const item = createElement('li', `mission-change mission-change-${kind}`);
    const badge = createElement('span', 'mission-change-kind', kind);
    const copy = createElement('span', 'mission-change-copy');
    copy.append(createElement('strong', '', title));
    if (detail) copy.append(createElement('span', '', detail));
    item.append(badge, copy);
    list.append(item);
  }

  function buildDeltaByPid(diff) {
    const index = {};
    const add = (rows, type, detailKey) => {
      (Array.isArray(rows) ? rows : []).forEach(row => {
        const pid = finite(row?.pid);
        if (pid == null) return;
        if (!index[pid]) index[pid] = [];
        index[pid].push({
          type,
          value: detailKey ? finite(row[detailKey], 0) : null,
        });
      });
    };
    add(diff.entered, 'entered');
    add(diff.cpu_spikes, 'cpu', 'delta_cpu');
    add(diff.memory_spikes, 'memory', 'delta_mem');
    return index;
  }

  function renderProcessDiff(diff) {
    const safeDiff = diff && typeof diff === 'object' ? diff : {};
    const observedAt = finite(safeDiff.observed_at, 0);
    if (observedAt > 0 && observedAt <= state.lastProcessDiffAt) return;
    if (observedAt > 0) state.lastProcessDiffAt = observedAt;
    const counts = safeDiff.counts || {};
    const total = ['entered', 'left', 'cpu_spikes', 'memory_spikes']
      .reduce((sum, key) => sum + Math.max(0, finite(counts[key], 0)), 0);
    const summary = safeDiff.baseline
      ? 'Baseline captured. The next top-process sample will reveal material changes.'
      : total === 0
        ? 'No material change between the latest top-process samples.'
        : `${total} material ${total === 1 ? 'change' : 'changes'} in the latest top-process comparison.`;

    setText('missionProcessSummary', summary);
    setText('processDiffSummary', summary);
    setText('processDiffScope', safeDiff.scope === 'top-process-sample' ? 'Top-process sample' : 'Sample comparison');

    const details = byId('processDiffDetails');
    if (details) {
      clear(details);
      [
        ['Entered sample', counts.entered],
        ['Left sample', counts.left],
        ['CPU jumps', counts.cpu_spikes],
        ['Memory jumps', counts.memory_spikes],
      ].forEach(([label, count]) => {
        const chip = createElement('div', 'process-diff-stat');
        chip.append(createElement('strong', '', Math.max(0, finite(count, 0))), createElement('span', '', label));
        details.append(chip);
      });
    }

    const list = byId('missionProcessChanges');
    if (list) {
      clear(list);
      const cpuSpikes = Array.isArray(safeDiff.cpu_spikes) ? safeDiff.cpu_spikes : [];
      const memorySpikes = Array.isArray(safeDiff.memory_spikes) ? safeDiff.memory_spikes : [];
      const entered = Array.isArray(safeDiff.entered) ? safeDiff.entered : [];
      const left = Array.isArray(safeDiff.left) ? safeDiff.left : [];

      cpuSpikes.slice(0, 2).forEach(row => appendChange(
        list,
        'cpu',
        row.name || 'Unknown process',
        `CPU +${Math.round(finite(row.delta_cpu, 0) * 10) / 10} points to ${formatPercent(row.cpu)}`
      ));
      memorySpikes.slice(0, 2).forEach(row => appendChange(
        list,
        'memory',
        row.name || 'Unknown process',
        `Memory +${Math.round(finite(row.delta_mem, 0) * 10) / 10} points`
      ));
      entered.slice(0, 2).forEach(row => appendChange(list, 'entered', row.name || 'Unknown process', 'Entered the top-process sample'));
      left.slice(0, 2).forEach(row => appendChange(list, 'left', row.name || 'Unknown process', 'Left the top-process sample'));

      while (list.children.length > 5) list.lastElementChild.remove();
      if (list.children.length === 0) list.append(createElement('li', 'mission-empty', safeDiff.baseline ? 'Waiting for the next sample.' : 'No material process delta detected.'));
    }

    window.missionProcessDiff = safeDiff;
    window.missionProcessDeltaByPid = buildDeltaByPid(safeDiff);
    document.dispatchEvent(new CustomEvent('vps:processdiff', { detail: safeDiff }));
  }

  function renderCausalEvents(events) {
    const list = byId('missionCausalEvents');
    if (!list) return;

    const rows = Array.isArray(events) ? events.slice(0, 6) : [];
    const signature = rows.map(event => `${event?.id || ''}:${event?.ts || ''}:${event?.phase || ''}:${event?.title || ''}`).join('|');
    if (signature === state.causalSignature) return;
    state.causalSignature = signature;
    clear(list);
    rows.forEach(event => {
      const phase = VALID_PHASES.has(event?.phase) ? event.phase : 'context';
      const item = createElement('li', `mission-causal-event mission-phase-${phase}`);
      const rail = createElement('span', 'mission-causal-phase', phase);
      const copy = createElement('span', 'mission-causal-copy');
      const heading = createElement('span', 'mission-causal-heading');
      heading.append(createElement('strong', '', event?.title || 'Untitled event'));
      const time = createElement('time', '', formatEventAge(event?.age_seconds));
      const timestamp = finite(event?.ts);
      if (timestamp != null) time.dateTime = new Date(timestamp * 1000).toISOString();
      heading.append(time);
      copy.append(heading);
      if (event?.detail) copy.append(createElement('span', 'mission-causal-detail', event.detail));
      item.append(rail, copy);
      list.append(item);
    });

    if (list.children.length === 0) list.append(createElement('li', 'mission-empty', 'No causal signals in the latest window.'));
  }

  function setBackgroundInert(enabled) {
    const layer = byId('missionWhyLayer');
    if (enabled) {
      state.inertElements = Array.from(document.body.children)
        .filter(element => element !== layer && element.tagName !== 'SCRIPT')
        .map(element => ({ element, wasInert: element.inert }));
      state.inertElements.forEach(({ element }) => { element.inert = true; });
      return;
    }
    state.inertElements.forEach(({ element, wasInert }) => { element.inert = wasInert; });
    state.inertElements = [];
  }

  function renderDrawer(requestedMetric) {
    const metric = requestedMetric === 'primary' ? currentExplanationKey() : requestedMetric;
    const explanation = state.snapshot?.explanations?.[metric] || fallbackExplanation(metric || 'cpu');
    const evidence = Array.isArray(explanation.evidence) ? explanation.evidence : [];
    const checks = Array.isArray(explanation.next_checks) ? explanation.next_checks : [];

    setText('missionWhyTitle', explanation.title || 'Why is this happening?');
    setText('missionWhySummary', explanation.summary || 'Supporting evidence is still being collected.');
    const confidence = finite(explanation.confidence);
    const coverageLabel = explanation.coverage_label;
    setText(
      'missionWhyConfidence',
      coverageLabel || (confidence == null ? 'Evidence coverage pending' : `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}% evidence coverage`)
    );

    const evidenceList = byId('missionWhyEvidence');
    if (evidenceList) {
      clear(evidenceList);
      evidence.forEach(row => {
        const tone = VALID_TONES.has(row?.tone) ? row.tone : 'neutral';
        const pair = createElement('div', `mission-evidence-pair mission-tone-${tone}`);
        pair.append(createElement('dt', '', row?.label || 'Signal'), createElement('dd', '', row?.value || '—'));
        evidenceList.append(pair);
      });
      if (evidenceList.children.length === 0) {
        const pair = createElement('div', 'mission-evidence-pair mission-tone-neutral');
        pair.append(createElement('dt', '', 'Evidence'), createElement('dd', '', 'Collecting'));
        evidenceList.append(pair);
      }
    }

    const checkList = byId('missionWhyChecks');
    if (checkList) {
      clear(checkList);
      checks.forEach(check => {
        if (!check?.page) return;
        const button = createElement('button', 'mission-check-btn', check.label || `Open ${check.page}`);
        button.type = 'button';
        button.dataset.missionPage = check.page;
        checkList.append(button);
      });
      if (checkList.children.length === 0) checkList.append(createElement('span', 'mission-empty', 'No additional check is required.'));
    }
  }

  function openDrawer(metric, opener) {
    const layer = byId('missionWhyLayer');
    const drawer = byId('missionWhyDrawer');
    if (!layer || !drawer) return;

    state.drawerMetric = metric || 'primary';
    state.drawerOpener = opener instanceof HTMLElement ? opener : document.activeElement;
    renderDrawer(state.drawerMetric);
    setBackgroundInert(true);
    document.body.classList.add('mission-drawer-open');
    layer.hidden = false;
    window.requestAnimationFrame(() => layer.classList.add('is-open'));
    if (state.drawerOpener instanceof HTMLElement) state.drawerOpener.setAttribute('aria-expanded', 'true');
    byId('missionWhyClose')?.focus();
  }

  function closeDrawer() {
    const layer = byId('missionWhyLayer');
    if (!layer || layer.hidden) return;
    layer.classList.remove('is-open');
    layer.hidden = true;
    document.body.classList.remove('mission-drawer-open');
    setBackgroundInert(false);
    if (state.drawerOpener instanceof HTMLElement) {
      state.drawerOpener.setAttribute('aria-expanded', 'false');
      state.drawerOpener.focus();
    }
    state.drawerMetric = null;
    state.drawerOpener = null;
  }

  function trapDrawerFocus(event) {
    const layer = byId('missionWhyLayer');
    const drawer = byId('missionWhyDrawer');
    if (!layer || layer.hidden || !drawer) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDrawer();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(drawer.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter(element => !element.disabled && element.getClientRects().length > 0);
    if (focusable.length === 0) {
      event.preventDefault();
      drawer.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function navigate(page) {
    if (!page) return;
    closeDrawer();
    const navButton = document.querySelector(`.nav-btn[data-page="${CSS.escape(page)}"]`);
    if (navButton) navButton.click();
  }

  function applySnapshot(payload) {
    const snapshot = normalizeSnapshot(payload);
    if (!snapshot || isOlderSnapshot(snapshot)) return false;
    const bootChanged = Boolean(
      state.snapshot?.boot_id && snapshot.boot_id && state.snapshot.boot_id !== snapshot.boot_id
    );
    if (bootChanged) {
      state.lastProcessDiffAt = 0;
      state.causalSignature = '__boot-reset__';
    }
    state.snapshot = snapshot;
    state.clientStale = false;
    state.receivedAt = Date.now();
    window.missionControlSnapshot = snapshot;
    renderMissionState();
    renderProcessDiff(snapshot.process_diff);
    renderCausalEvents(snapshot.causal_events);
    document.dispatchEvent(new CustomEvent('vps:missionupdate', { detail: snapshot }));
    return true;
  }

  function mergeMissionState(payload) {
    const update = normalizeSnapshot(payload);
    if (!update || isOlderSnapshot(update)) return false;
    const bootChanged = Boolean(
      state.snapshot?.boot_id && update.boot_id && state.snapshot.boot_id !== update.boot_id
    );
    if (bootChanged) {
      state.lastProcessDiffAt = 0;
      state.causalSignature = '__boot-reset__';
      state.snapshot = update;
      renderProcessDiff({
        observed_at: 0,
        scope: 'top-process-sample',
        baseline: true,
        counts: { entered: 0, left: 0, cpu_spikes: 0, memory_spikes: 0 },
        entered: [],
        left: [],
        cpu_spikes: [],
        memory_spikes: [],
      });
      renderCausalEvents([]);
    } else {
      state.snapshot = { ...(state.snapshot || {}), ...update };
    }
    state.clientStale = false;
    state.receivedAt = Date.now();
    window.missionControlSnapshot = state.snapshot;
    renderMissionState();
    if (update.process_diff) renderProcessDiff(update.process_diff);
    if (update.causal_events) renderCausalEvents(update.causal_events);
    document.dispatchEvent(new CustomEvent('vps:missionupdate', { detail: update }));
    return true;
  }

  async function fetchSnapshot() {
    if (state.fetchController) state.fetchController.abort();
    const controller = new AbortController();
    state.fetchController = controller;
    state.lastFetchAttemptAt = Date.now();
    try {
      const response = await fetch('/api/mission-control', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Mission Control returned ${response.status}`);
      const snapshot = await response.json();
      if (applySnapshot(snapshot)) state.lastFetchAt = Date.now();
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (!state.snapshot) {
        setText('missionStateChip', 'Unavailable');
        setText('missionWeather', 'Snapshot not ready');
        setText('missionNowTitle', 'Mission Control is temporarily unavailable');
        setText('missionNowSummary', 'Core dashboard telemetry remains available while the operational snapshot reconnects.');
        setText('missionFreshness', 'Retrying on the next live signal');
      } else renderFreshness();
    } finally {
      if (state.fetchController === controller) state.fetchController = null;
    }
  }

  function scheduleRefresh({ immediate = false, minInterval = 30000 } = {}) {
    const lastRequestAt = Math.max(state.lastFetchAt, state.lastFetchAttemptAt);
    const elapsed = Date.now() - lastRequestAt;
    const throttleDelay = immediate ? 0 : Math.max(0, minInterval - elapsed);
    const delay = Math.max(250, throttleDelay);
    const dueAt = Date.now() + delay;
    if (state.refreshTimer && state.refreshDueAt <= dueAt) return;
    window.clearTimeout(state.refreshTimer);
    state.refreshDueAt = dueAt;
    state.refreshTimer = window.setTimeout(() => {
      state.refreshTimer = null;
      state.refreshDueAt = 0;
      fetchSnapshot();
    }, delay);
  }

  document.querySelectorAll('[data-mission-why]').forEach(button => {
    button.setAttribute('aria-controls', 'missionWhyDrawer');
    button.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('click', event => {
    const whyButton = event.target.closest('[data-mission-why]');
    if (whyButton) {
      event.preventDefault();
      openDrawer(whyButton.dataset.missionWhy, whyButton);
      return;
    }
    const pageButton = event.target.closest('[data-mission-page]');
    if (pageButton) {
      event.preventDefault();
      navigate(pageButton.dataset.missionPage);
    }
  });
  byId('missionWhyClose')?.addEventListener('click', closeDrawer);
  byId('missionWhyBackdrop')?.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', trapDrawerFocus);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      renderFreshness();
      scheduleRefresh({ immediate: true });
    }
  });

  if (window.socket?.on) {
    window.socket.on('mission-state', payload => {
      const previousLevel = state.snapshot?.level;
      const previousSignal = state.snapshot?.primary_signal?.key;
      if (!mergeMissionState(payload)) return;
      const meaningfulTransition = previousLevel !== state.snapshot?.level || previousSignal !== state.snapshot?.primary_signal?.key;
      scheduleRefresh({ immediate: meaningfulTransition || !state.snapshot?.explanations });
    });
    window.socket.on('process-diff', diff => {
      const observedAt = finite(diff?.observed_at, 0);
      if (observedAt > 0 && observedAt < state.lastProcessDiffAt) return;
      state.snapshot = { ...(state.snapshot || {}), process_diff: diff };
      renderProcessDiff(diff);
      scheduleRefresh({ minInterval: 15000 });
    });
    window.socket.on('timeline-event', () => scheduleRefresh({ minInterval: 5000 }));
  }

  fetchSnapshot();
})();
