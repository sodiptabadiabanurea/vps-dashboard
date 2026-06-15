// Incident Timeline
(function() {
  let activeCategories = new Set();
  let currentRange = '24h';

  async function loadFilters() {
    try {
      const res = await fetch('/api/timeline/categories');
      const cats = await res.json();
      const container = document.getElementById('timelineFilters');
      if (!container) return;
      container.innerHTML = cats.map(c => {
        const active = activeCategories.has(c.id) || activeCategories.size === 0;
        return `<span class="timeline-filter-chip${active ? ' active' : ''}" data-cat="${c.id}" onclick="window.toggleTimelineFilter('${c.id}', this)">${c.icon} ${c.id}</span>`;
      }).join('');
    } catch (e) { /* filters are nice-to-have */ }
  }

  window.toggleTimelineFilter = function(cat, el) {
    if (el.classList.contains('active')) {
      activeCategories.add(cat);
      el.classList.remove('active');
    } else {
      activeCategories.delete(cat);
      el.classList.add('active');
    }
    // If all are active (or all inactive), show all
    if (activeCategories.size === 0 || document.querySelectorAll('.timeline-filter-chip.active').length === 0) {
      activeCategories.clear();
    }
    loadTimeline();
  };

  function formatTime(ts) {
    const d = new Date(ts * 1000);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    return isToday ? time : d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) + ' ' + time;
  }

  async function loadTimeline() {
    const container = document.getElementById('timelineFeed');
    if (!container) return;

    try {
      const catParam = activeCategories.size > 0 ? '&category=' + [...activeCategories].join(',') : '';
      const res = await fetch(`/api/timeline?range=${currentRange}&limit=200${catParam}`);
      const events = await res.json();

      if (events.length === 0) {
        container.innerHTML = '<p class="empty-state">No events in this time range</p>';
        return;
      }

      // Group by hour for visual separation
      let lastHour = '';
      container.innerHTML = events.map(e => {
        const d = new Date(e.ts * 1000);
        const hourKey = d.toDateString() + ' ' + d.getHours();
        let hourLabel = '';
        if (hourKey !== lastHour) {
          lastHour = hourKey;
          hourLabel = `<div style="color:var(--text-muted);font-size:11px;padding:8px 0 4px 0;margin-left:-28px;font-weight:600">${d.toLocaleTimeString('id-ID', {hour:'2-digit',minute:'2-digit'})} — ${d.toLocaleDateString('id-ID',{weekday:'short',day:'numeric',month:'short'})}</div>`;
        }

        const detail = e.detail || '';
        const meta = Object.entries(e.metadata || {}).filter(([k]) => k !== 'value' && k !== 'threshold').map(([k, v]) => `${k}: ${v}`).join(' · ');
        const metaStr = meta ? `<div class="timeline-meta">${meta}</div>` : '';

        return `
          ${hourLabel}
          <div class="timeline-item" data-id="${e.id}">
            <div class="timeline-dot ${e.category}"></div>
            <div class="timeline-item-header">
              <span class="timeline-icon">${e.icon}</span>
              <span class="timeline-title">${e.title}</span>
              <span class="timeline-time">${formatTime(e.ts)}</span>
            </div>
            ${detail ? `<div class="timeline-detail">${detail}</div>` : ''}
            ${metaStr}
          </div>
        `;
      }).join('');
    } catch (err) {
      container.innerHTML = '<p class="empty-state">Timeline unavailable</p>';
    }
  }

  // Real-time updates via Socket.IO
  if (typeof socket !== 'undefined') {
    socket.on('timeline-event', (event) => {
      const page = document.getElementById('page-timeline');
      if (!page || !page.classList.contains('active')) return;

      // Only auto-append if viewing recent range
      if (currentRange === '1h' || currentRange === '6h') {
        const feed = document.getElementById('timelineFeed');
        const d = new Date(event.ts * 1000);
        const html = `
          <div class="timeline-item" style="animation: fadeIn 0.3s ease">
            <div class="timeline-dot ${event.category}"></div>
            <div class="timeline-item-header">
              <span class="timeline-icon">${event.icon}</span>
              <span class="timeline-title">${event.title}</span>
              <span class="timeline-time">${formatTime(event.ts)}</span>
            </div>
            ${event.detail ? `<div class="timeline-detail">${event.detail}</div>` : ''}
          </div>
        `;
        feed.insertAdjacentHTML('afterbegin', html);
        // Remove old items beyond 200
        const items = feed.querySelectorAll('.timeline-item');
        if (items.length > 200) items[items.length - 1].remove();
      }
    });
  }

  // Range selector
  const rangeEl = document.getElementById('timelineRange');
  if (rangeEl) {
    rangeEl.addEventListener('change', () => {
      currentRange = rangeEl.value;
      loadTimeline();
    });
  }

  // Load on page switch
  window.loadTimeline = function() {
    loadFilters();
    loadTimeline();
  };

  // Initial load if visible
  const page = document.getElementById('page-timeline');
  if (page && page.classList.contains('active')) {
    loadTimeline();
  }

  // Also hook into the existing page-switch mechanism
  const originalLoad = window.loadAlerts;
  const observer = new MutationObserver(() => {
    if (page && page.classList.contains('active')) loadTimeline();
  });
  observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
})();
