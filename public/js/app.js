// Main app controller — navigation, dialogs, toasts
(function() {
  // Navigation
  document.querySelectorAll('[data-page]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const page = btn.dataset.page;

      // Update nav buttons
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelector(`.nav-btn[data-page="${page}"]`)?.classList.add('active');

      // Update pages
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById(`page-${page}`)?.classList.add('active');

      // Load page-specific data
      if (page === 'charts' && window.loadCharts) window.loadCharts();
      if (page === 'alerts' && window.loadAlerts) window.loadAlerts();
      if (page === 'terminal' && window.initTerminal) window.initTerminal();
      if (page === 'docker' && window.loadDocker) window.loadDocker();
      if (page === 'files' && window.fmLoad) window.fmLoad();
      if (page === 'uptime' && window.loadUptime) window.loadUptime();
    });
  });

  // Theme toggle
  document.getElementById('themeToggle')?.addEventListener('click', window.toggleTheme);

  // Toast
  window.showToast = function(msg, isError) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.style.background = isError ? 'var(--red)' : 'var(--accent)';
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
  };

  // Confirm dialog
  let confirmCallback = null;

  window.showConfirm = function(title, body, onConfirm) {
    document.getElementById('dialogTitle').textContent = title;
    document.getElementById('dialogBody').textContent = body;
    document.getElementById('confirmDialog').classList.remove('hidden');
    confirmCallback = onConfirm;
  };

  document.getElementById('dialogConfirm')?.addEventListener('click', () => {
    document.getElementById('confirmDialog').classList.add('hidden');
    if (confirmCallback) confirmCallback();
    confirmCallback = null;
  });

  document.getElementById('dialogCancel')?.addEventListener('click', () => {
    document.getElementById('confirmDialog').classList.add('hidden');
    confirmCallback = null;
  });

  // Alert badge click
  document.getElementById('alertBtn')?.addEventListener('click', () => {
    document.querySelector('.nav-btn[data-page="alerts"]')?.click();
    document.getElementById('alertBadge').textContent = '0';
    document.getElementById('alertBadge').classList.add('hidden');
  });
})();
