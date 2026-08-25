// Incident Timeline: chronological feed and causal signal grouping
(function() {
  'use strict';

  const PHASES = [
    { id: 'change', label: '1. Change', description: 'Deployments or security changes that may alter system behavior.' },
    { id: 'trigger', label: '2. Trigger', description: 'Threshold crossings and alerts that first exposed pressure.' },
    { id: 'impact', label: '3. Impact', description: 'Service or uptime effects visible to operators or users.' },
    { id: 'recovery', label: '4. Recovery', description: 'Signals that indicate service restoration or resolution.' },
    { id: 'context', label: 'Context', description: 'Supporting events that do not fit a stronger causal role.' },
  ];
  const KNOWN_CATEGORIES = new Set(['alert', 'deploy', 'uptime', 'system', 'service', 'security']);
  const FALLBACK_ICONS = {
    alert: '\u26a0\ufe0f',
    deploy: '\ud83d\ude80',
    uptime: '\ud83c\udf10',
    system: '\u2699\ufe0f',
    service: '\ud83d\udd27',
    security: '\ud83d\udd12',
  };
  const RANGE_SECONDS = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000 };

  let categories = [];
  let selectedCategories = new Set();
  let filtersInitialized = false;
  let filterRequest = null;
  let timelineEvents = [];
  let missionEvents = [];
  let missionEventSignature = '';
  let currentRange = '24h';
  let currentMode = 'chronological';
  let timelineRequest = null;
  let timelineRequestId = 0;
  let timelineLoading = false;
  let timelineLoaded = false;
  let pageLoadScheduled = false;

  function text(value, fallback = '', maxLength = 360) {
    if (value == null) return fallback;
    return String(value).slice(0, maxLength);
  }

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function normalizeMetadata(metadata) {
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) return metadata;
    if (typeof metadata !== 'string') return {};
    try {
      const parsed = JSON.parse(metadata);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function classifyPhase(event) {
    const explicit = text(event?.phase).toLowerCase();
    if (PHASES.some(phase => phase.id === explicit)) return explicit;

    const description = `${text(event?.title)} ${text(event?.detail)}`.toLowerCase();
    const category = text(event?.category).toLowerCase();
    if (/recover|restored|resolved|back online|active again/.test(description)) return 'recovery';
    if (category === 'deploy' || category === 'security') return 'change';
    if (category === 'alert') return 'trigger';
    if (category === 'service' || category === 'uptime') return 'impact';
    return 'context';
  }

  function normalizeEvent(event) {
    const source = event && typeof event === 'object' ? event : {};
    const category = text(source.category, 'system', 40).toLowerCase();
    const rawTimestamp = number(source.ts);
    const metadata = normalizeMetadata(source.metadata);
    const correlationId = text(source.correlation_id || metadata.correlation_id, '', 80);
    const relation = text(source.relation || metadata.relation, '', 40);
    return {
      id: text(source.id, '', 80),
      ts: rawTimestamp > 1e12 ? rawTimestamp / 1000 : rawTimestamp,
      type: text(source.type, '', 80),
      category,
      title: text(source.title, 'Untitled event', 180),
      detail: text(source.detail, '', 360),
      source: text(source.source, '', 100),
      metadata: {
        ...metadata,
        ...(correlationId && !metadata.correlation_id ? { correlation_id: correlationId } : {}),
        ...(relation && !metadata.relation ? { relation } : {}),
      },
      correlation_id: correlationId,
      relation,
      icon: text(source.icon, FALLBACK_ICONS[category] || '\ud83d\udccc', 8),
      phase: classifyPhase({ ...source, phase: source.phase || metadata.phase }),
    };
  }

  function eventKey(event) {
    if (event.id) return `id:${event.id}`;
    return `${event.ts}:${event.type}:${event.category}:${event.title}`;
  }

  function safeCategoryClass(category) {
    return KNOWN_CATEGORIES.has(category) ? category : 'system';
  }

  function eventDate(event) {
    const value = number(event.ts);
    if (value <= 0) return null;
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatTime(event) {
    const date = eventDate(event);
    if (!date) return 'Unknown time';
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const time = date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    if (isToday) return time;
    return `${date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })} ${time}`;
  }

  function hourKey(event) {
    const date = eventDate(event);
    if (!date) return 'unknown';
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`;
  }

  function hourLabel(event) {
    const date = eventDate(event);
    if (!date) return 'Unknown time';
    const hour = date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    const day = date.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' });
    return `${hour} - ${day}`;
  }

  function metadataText(value) {
    if (value == null) return '';
    if (typeof value === 'string') return text(value, '', 120);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return text(JSON.stringify(value), '', 120);
    } catch (_) {
      return '[unavailable]';
    }
  }

  function appendMetadata(container, event) {
    const entries = Object.entries(event.metadata)
      .filter(([, value]) => value != null)
      .slice(0, 6)
      .map(([key, value]) => `${text(key, 'field', 40)}: ${metadataText(value)}`)
      .filter(entry => !entry.endsWith(': '));
    if (event.source) entries.unshift(`source: ${event.source}`);
    if (!entries.length) return;

    const metadata = document.createElement('div');
    metadata.className = 'timeline-meta';
    metadata.textContent = entries.join(' | ');
    container.appendChild(metadata);
  }

  function createEventItem(event, showPhase) {
    const item = document.createElement('article');
    item.className = `timeline-item phase-${event.phase}`;
    item.setAttribute('role', 'listitem');
    if (event.id) item.dataset.id = event.id;

    const dot = document.createElement('span');
    dot.className = `timeline-dot ${safeCategoryClass(event.category)}`;
    dot.setAttribute('aria-hidden', 'true');
    item.appendChild(dot);

    const header = document.createElement('div');
    header.className = 'timeline-item-header';

    const icon = document.createElement('span');
    icon.className = 'timeline-icon';
    icon.textContent = event.icon;
    icon.setAttribute('aria-hidden', 'true');
    header.appendChild(icon);

    const title = document.createElement('span');
    title.className = 'timeline-title';
    title.textContent = event.title;
    header.appendChild(title);

    if (showPhase) {
      const phase = document.createElement('span');
      phase.className = `timeline-phase-badge phase-${event.phase}`;
      phase.textContent = PHASES.find(value => value.id === event.phase)?.label.replace(/^\d+\.\s*/, '') || 'Context';
      header.appendChild(phase);
    }

    const time = document.createElement('time');
    time.className = 'timeline-time';
    const date = eventDate(event);
    if (date) time.dateTime = date.toISOString();
    time.textContent = formatTime(event);
    header.appendChild(time);
    item.appendChild(header);

    if (event.detail) {
      const detail = document.createElement('div');
      detail.className = 'timeline-detail';
      detail.textContent = event.detail;
      item.appendChild(detail);
    }
    appendMetadata(item, event);
    return item;
  }

  function feed() {
    return document.getElementById('timelineFeed');
  }

  function renderEmpty(message) {
    const container = feed();
    if (!container) return;
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = message;
    container.replaceChildren(empty);
    container.setAttribute('aria-busy', 'false');
  }

  function renderLoading() {
    const container = feed();
    if (!container) return;
    const loading = document.createElement('p');
    loading.className = 'empty-state';
    loading.textContent = 'Loading timeline...';
    container.replaceChildren(loading);
    container.setAttribute('aria-busy', 'true');
  }

  function selected(events) {
    if (!categories.length) return events;
    return events.filter(event => (
      !categories.some(category => category.id === event.category) || selectedCategories.has(event.category)
    ));
  }

  function mergeCausalEvents() {
    const merged = new Map();
    timelineEvents.forEach(event => merged.set(eventKey(event), event));
    missionEvents.forEach(event => {
      const key = eventKey(event);
      const existing = merged.get(key);
      merged.set(key, existing ? {
        ...existing,
        ...event,
        icon: existing.icon || event.icon,
        metadata: existing.metadata,
      } : event);
    });
    return [...merged.values()];
  }

  function renderChronological() {
    const container = feed();
    if (!container) return;
    const events = selected(timelineEvents).sort((a, b) => b.ts - a.ts);
    if (!events.length) {
      renderEmpty('No events match this time range and filter.');
      return;
    }

    const fragment = document.createDocumentFragment();
    let currentHour = '';
    let hourList = null;
    events.forEach(event => {
      const key = hourKey(event);
      if (key !== currentHour) {
        currentHour = key;
        const group = document.createElement('section');
        group.className = 'timeline-hour-group';

        const heading = document.createElement('h3');
        heading.className = 'timeline-hour-label';
        heading.textContent = hourLabel(event);
        group.appendChild(heading);

        hourList = document.createElement('div');
        hourList.className = 'timeline-hour-events';
        hourList.setAttribute('role', 'list');
        group.appendChild(hourList);
        fragment.appendChild(group);
      }
      hourList.appendChild(createEventItem(event, false));
    });
    container.replaceChildren(fragment);
  }

  function renderCausal() {
    const container = feed();
    if (!container) return;
    const cutoff = Date.now() / 1000 - (RANGE_SECONDS[currentRange] || RANGE_SECONDS['24h']);
    const events = selected(mergeCausalEvents())
      .filter(event => event.ts >= cutoff)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 30);
    if (!events.length) {
      renderEmpty('No recent causal signals match the current filter.');
      return;
    }

    const fragment = document.createDocumentFragment();
    const note = document.createElement('p');
    note.className = 'timeline-causal-note';
    note.textContent = 'Shared correlation IDs form action chains. Remaining evidence is grouped by operational phase; neither view proves root cause.';
    fragment.appendChild(note);

    const correlated = new Map();
    const uncorrelated = [];
    events.forEach(event => {
      if (!event.correlation_id) {
        uncorrelated.push(event);
        return;
      }
      if (!correlated.has(event.correlation_id)) correlated.set(event.correlation_id, []);
      correlated.get(event.correlation_id).push(event);
    });

    [...correlated.entries()]
      .sort((a, b) => Math.max(...b[1].map(event => event.ts)) - Math.max(...a[1].map(event => event.ts)))
      .forEach(([, chainEvents], index) => {
        const section = document.createElement('section');
        section.className = 'timeline-causal-group timeline-correlation-chain';
        section.setAttribute('aria-labelledby', `timeline-chain-${index}`);

        const header = document.createElement('div');
        header.className = 'timeline-causal-header';
        const title = document.createElement('h3');
        title.id = `timeline-chain-${index}`;
        title.textContent = 'Correlated action chain';
        const description = document.createElement('p');
        description.textContent = `${chainEvents.length} ${chainEvents.length === 1 ? 'event shares' : 'events share'} one action correlation ID.`;
        header.append(title, description);
        section.appendChild(header);

        const list = document.createElement('div');
        list.className = 'timeline-causal-events';
        list.setAttribute('role', 'list');
        chainEvents.sort((a, b) => a.ts - b.ts).forEach(event => list.appendChild(createEventItem(event, true)));
        section.appendChild(list);
        fragment.appendChild(section);
      });

    if (correlated.size > 0 && uncorrelated.length > 0) {
      const poolLabel = document.createElement('h3');
      poolLabel.className = 'timeline-evidence-pool-label';
      poolLabel.textContent = 'Uncorrelated evidence pool';
      fragment.appendChild(poolLabel);
    }

    PHASES.forEach(phase => {
      const phaseEvents = uncorrelated
        .filter(event => event.phase === phase.id)
        .sort((a, b) => a.ts - b.ts);
      if (!phaseEvents.length) return;

      const section = document.createElement('section');
      section.className = `timeline-causal-group phase-${phase.id}`;
      section.setAttribute('aria-labelledby', `timeline-phase-${phase.id}`);

      const header = document.createElement('div');
      header.className = 'timeline-causal-header';
      const title = document.createElement('h3');
      title.id = `timeline-phase-${phase.id}`;
      title.textContent = phase.label;
      const description = document.createElement('p');
      description.textContent = phase.description;
      header.append(title, description);
      section.appendChild(header);

      const list = document.createElement('div');
      list.className = 'timeline-causal-events';
      list.setAttribute('role', 'list');
      phaseEvents.forEach(event => list.appendChild(createEventItem(event, true)));
      section.appendChild(list);
      fragment.appendChild(section);
    });
    container.replaceChildren(fragment);
  }

  function renderTimeline() {
    if (!timelineLoaded && timelineLoading && !missionEvents.length) {
      renderLoading();
      return;
    }
    if (currentMode === 'causal') renderCausal();
    else renderChronological();
    feed()?.setAttribute('aria-busy', 'false');
  }

  function renderFilters() {
    const container = document.getElementById('timelineFilters');
    if (!container) return;
    const fragment = document.createDocumentFragment();
    categories.forEach(category => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'timeline-filter-chip';
      if (selectedCategories.has(category.id)) button.classList.add('active');
      button.dataset.cat = category.id;
      button.setAttribute('aria-pressed', String(selectedCategories.has(category.id)));
      button.textContent = `${category.icon} ${category.id}`;
      button.addEventListener('click', () => toggleCategory(category.id));
      fragment.appendChild(button);
    });
    container.replaceChildren(fragment);
  }

  function toggleCategory(category) {
    if (!categories.some(item => item.id === category)) return;
    if (selectedCategories.has(category)) selectedCategories.delete(category);
    else selectedCategories.add(category);
    renderFilters();
    renderTimeline();
  }

  async function loadFilters() {
    if (filterRequest) return filterRequest;
    filterRequest = (async () => {
      try {
        const response = await fetch('/api/timeline/categories');
        if (!response.ok) throw new Error('Categories unavailable');
        const data = await response.json();
        if (!Array.isArray(data)) throw new Error('Invalid categories');

        const next = data
          .filter(category => category && typeof category === 'object')
          .map(category => ({
            id: text(category.id, '', 40).toLowerCase(),
            icon: text(category.icon, FALLBACK_ICONS[category.id] || '\ud83d\udccc', 8),
          }))
          .filter(category => category.id);

        if (!filtersInitialized) {
          selectedCategories = new Set(next.map(category => category.id));
          filtersInitialized = true;
        } else {
          selectedCategories = new Set([...selectedCategories].filter(id => next.some(category => category.id === id)));
        }
        categories = next;
        renderFilters();
        renderTimeline();
      } catch (_) {
        // The timeline remains usable without category controls.
      } finally {
        filterRequest = null;
      }
    })();
    return filterRequest;
  }

  async function loadTimelineData() {
    const requestId = ++timelineRequestId;
    const requestStartedAt = Date.now() / 1000;
    timelineLoading = true;
    feed()?.setAttribute('aria-busy', 'true');
    timelineRequest?.abort();
    timelineRequest = typeof AbortController === 'function' ? new AbortController() : null;

    try {
      const options = timelineRequest ? { signal: timelineRequest.signal } : {};
      const response = await fetch(`/api/timeline?range=${encodeURIComponent(currentRange)}&limit=200`, options);
      if (!response.ok) throw new Error('Timeline unavailable');
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error('Invalid timeline response');
      if (requestId !== timelineRequestId) return;

      const fetched = data.map(normalizeEvent);
      const cutoff = requestStartedAt - (RANGE_SECONDS[currentRange] || RANGE_SECONDS['24h']);
      const merged = new Map(fetched.map(event => [eventKey(event), event]));
      timelineEvents
        .filter(event => event.ts >= Math.floor(requestStartedAt) - 1)
        .forEach(event => merged.set(eventKey(event), event));
      timelineEvents = [...merged.values()]
        .filter(event => event.ts >= cutoff)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 200);
      timelineLoaded = true;
      timelineLoading = false;
      renderTimeline();
    } catch (error) {
      if (error.name === 'AbortError' || requestId !== timelineRequestId) return;
      timelineLoading = false;
      if (!timelineEvents.length && !missionEvents.length) renderEmpty('Timeline unavailable.');
    }
  }

  function loadTimelinePage() {
    loadFilters();
    return loadTimelineData();
  }

  function setMode(mode) {
    if (mode !== 'causal' && mode !== 'chronological') return;
    currentMode = mode;
    const causal = document.getElementById('timelineModeCausal') || document.querySelector('[data-timeline-view="causal"]');
    const chronological = document.getElementById('timelineModeChronological') || document.querySelector('[data-timeline-view="chronological"]');
    [
      [causal, mode === 'causal'],
      [chronological, mode === 'chronological'],
    ].forEach(([button, active]) => {
      if (!button) return;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const note = document.getElementById('timelineViewNote');
    if (note) {
      note.textContent = mode === 'causal'
        ? 'Grouped by operational role: change, trigger, impact, recovery, then supporting context.'
        : 'Ordered by timestamp, newest event first.';
    }
    renderTimeline();
  }

  function applyMissionSnapshot(payload) {
    const snapshot = payload?.snapshot || payload;
    if (!Array.isArray(snapshot?.causal_events)) return;
    const nextEvents = snapshot.causal_events.map(normalizeEvent);
    const signature = nextEvents.map(event => `${eventKey(event)}:${event.phase}:${event.correlation_id}`).join('|');
    if (signature === missionEventSignature) return;
    missionEventSignature = signature;
    missionEvents = nextEvents;
    if (currentMode === 'causal') renderTimeline();
  }

  function isTimelinePageActive() {
    return document.getElementById('page-timeline')?.classList.contains('active');
  }

  function scheduleTimelineLoad() {
    if (pageLoadScheduled) return;
    pageLoadScheduled = true;
    queueMicrotask(() => {
      pageLoadScheduled = false;
      if (isTimelinePageActive()) loadTimelinePage();
    });
  }

  function handlePageChange(event) {
    const detail = event?.detail;
    const page = typeof detail === 'string' ? detail : detail?.page;
    if (page === 'timeline' || (!page && isTimelinePageActive())) scheduleTimelineLoad();
  }

  const timelineFeed = feed();
  if (timelineFeed) {
    timelineFeed.setAttribute('role', 'region');
    timelineFeed.setAttribute('aria-label', 'Incident timeline events');
  }

  const causalButton = document.getElementById('timelineModeCausal') || document.querySelector('[data-timeline-view="causal"]');
  const chronologicalButton = document.getElementById('timelineModeChronological') || document.querySelector('[data-timeline-view="chronological"]');
  causalButton?.addEventListener('click', () => setMode('causal'));
  chronologicalButton?.addEventListener('click', () => setMode('chronological'));
  if (causalButton?.classList.contains('active') || causalButton?.getAttribute('aria-pressed') === 'true') {
    currentMode = 'causal';
  }
  setMode(currentMode);

  document.getElementById('timelineRange')?.addEventListener('change', event => {
    currentRange = text(event.target.value, '24h', 8);
    loadTimelineData();
  });

  if (window.socket && typeof window.socket.on === 'function') {
    window.socket.on('timeline-event', event => {
      const normalized = normalizeEvent(event);
      const key = eventKey(normalized);
      timelineEvents = [normalized, ...timelineEvents.filter(item => eventKey(item) !== key)].slice(0, 200);
      if (isTimelinePageActive()) renderTimeline();
    });
    window.socket.on('mission-state', applyMissionSnapshot);
  }

  const snapshotEvents = [
    'mission-control:snapshot',
    'mission-control-snapshot',
    'mission-control:update',
    'vps:mission-snapshot',
  ];
  snapshotEvents.forEach(eventName => {
    window.addEventListener(eventName, event => applyMissionSnapshot(event.detail));
    document.addEventListener(eventName, event => applyMissionSnapshot(event.detail));
  });
  document.addEventListener('vps:missionupdate', event => applyMissionSnapshot(event.detail));
  window.addEventListener('vps:pagechange', handlePageChange);
  document.addEventListener('vps:pagechange', handlePageChange);
  document.querySelectorAll('[data-page="timeline"]').forEach(button => {
    button.addEventListener('click', scheduleTimelineLoad);
  });

  window.toggleTimelineFilter = toggleCategory;
  window.loadTimeline = loadTimelinePage;

  if (window.missionControlSnapshot) applyMissionSnapshot(window.missionControlSnapshot);
  if (isTimelinePageActive()) loadTimelinePage();
})();
