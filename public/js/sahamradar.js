// SahamRadar metrics widget
(function() {
  async function loadSahamMetrics() {
    const ids = ['srUsers', 'srSubs', 'srOrders', 'srRecent'];
    try {
      const res = await fetch('/api/sahamradar/metrics');
      if (!res.ok) throw new Error('API unavailable');
      const m = await res.json();
      if (m.error) {
        ids.forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '—'; });
        const plans = document.getElementById('srPlans');
        if (plans) plans.textContent = 'DB unavailable';
        return;
      }
      document.getElementById('srUsers').textContent = m.total_users;
      document.getElementById('srSubs').textContent = m.active_subscribers;
      document.getElementById('srOrders').textContent = m.total_orders;
      document.getElementById('srRecent').textContent = m.recent_users_7d;
      const plans = document.getElementById('srPlans');
      if (plans && m.plan_breakdown) {
        plans.textContent = m.plan_breakdown.split('|').map(p => {
          const [code, count] = p.split(':');
          return `${code}: ${count}`;
        }).join(' · ');
      }
    } catch (err) {
      ids.forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '—'; });
      const plans = document.getElementById('srPlans');
      if (plans) plans.textContent = '';
    }
  }

  // Load on dashboard page
  const observer = new MutationObserver(() => {
    const dash = document.getElementById('page-dashboard');
    if (dash && dash.classList.contains('active')) loadSahamMetrics();
  });
  observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });

  // Initial load if dashboard is already active
  if (document.getElementById('page-dashboard')?.classList.contains('active')) {
    loadSahamMetrics();
  }

  // Refresh every 60s
  setInterval(() => {
    if (document.getElementById('page-dashboard')?.classList.contains('active')) {
      loadSahamMetrics();
    }
  }, 60000);
})();
