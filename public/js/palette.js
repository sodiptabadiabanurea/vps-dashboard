// Command Palette — Cmd/Ctrl+K power menu
(function() {
  const COMMANDS = [
    // Navigation
    { id: 'nav-cpu', label: 'CPU Chart', keywords: ['cpu', 'chart', 'processor'], icon: '📊', action: () => nav('charts') && selectMetric('cpu') },
    { id: 'nav-ram', label: 'RAM Chart', keywords: ['ram', 'memory', 'chart'], icon: '📊', action: () => nav('charts') && selectMetric('ram') },
    { id: 'nav-network', label: 'Network Chart', keywords: ['network', 'net', 'traffic', 'chart'], icon: '📊', action: () => nav('charts') && selectMetric('network') },
    { id: 'nav-dashboard', label: 'Dashboard', keywords: ['dashboard', 'home', 'main'], icon: '🏠', action: () => nav('dashboard') },
    { id: 'nav-processes', label: 'Process Manager', keywords: ['processes', 'process', 'proc', 'ps'], icon: '📋', action: () => nav('processes') },
    { id: 'nav-alerts', label: 'Alert Configuration', keywords: ['alerts', 'alert', 'notification', 'threshold'], icon: '🔔', action: () => nav('alerts') },
    { id: 'nav-timeline', label: 'Incident Timeline', keywords: ['timeline', 'events', 'history', 'incident'], icon: '📜', action: () => nav('timeline') },
    { id: 'nav-terminal', label: 'Web Terminal', keywords: ['terminal', 'shell', 'console', 'bash'], icon: '🖥️', action: () => nav('terminal') },
    { id: 'nav-docker', label: 'Docker Monitor', keywords: ['docker', 'container', 'compose'], icon: '🐳', action: () => nav('docker') },
    { id: 'nav-files', label: 'File Manager', keywords: ['files', 'file', 'browse', 'folder'], icon: '🗂️', action: () => nav('files') },
    { id: 'nav-uptime', label: 'Uptime Monitor', keywords: ['uptime', 'ping', 'health', 'check'], icon: '⏱️', action: () => nav('uptime') },
    { id: 'nav-tools', label: 'Network Tools', keywords: ['tools', 'network', 'ping', 'dns', 'traceroute'], icon: '🔧', action: () => nav('tools') },
    { id: 'nav-security', label: 'Security', keywords: ['security', '2fa', 'auth', 'fail2ban'], icon: '🔒', action: () => nav('security') },
    { id: 'nav-logs', label: 'Log Viewer', keywords: ['logs', 'log', 'syslog', 'journal'], icon: '📝', action: () => nav('logs') },

    // Actions
    { id: 'act-restart-nginx', label: 'Restart Nginx', keywords: ['restart', 'nginx', 'web', 'server'], icon: '🔄', action: () => restartService('nginx') },
    { id: 'act-restart-dashboard', label: 'Restart VPS Dashboard', keywords: ['restart', 'dashboard', 'vps'], icon: '🔄', action: () => restartService('vps-dashboard') },
    { id: 'act-restart-saham', label: 'Restart SahamRadar', keywords: ['restart', 'saham', 'subscription'], icon: '🔄', action: () => restartService('saham-subscription') },
    { id: 'act-deploy', label: 'Deploy SahamRadar', keywords: ['deploy', 'ship', 'push', 'release'], icon: '🚀', action: () => deploy() },
    { id: 'act-health', label: 'Run Health Check', keywords: ['health', 'check', 'status', 'ok'], icon: '💚', action: () => healthCheck() },

    // Theme
    { id: 'theme-dark', label: 'Switch to Dark Theme', keywords: ['dark', 'theme', 'night'], icon: '🌙', action: () => setTheme('dark') },
    { id: 'theme-light', label: 'Switch to Light Theme', keywords: ['light', 'theme', 'day', 'white'], icon: '☀️', action: () => setTheme('light') },
  ];

  // --- Helpers ---
  function nav(page) {
    const btn = document.querySelector(`.nav-btn[data-page="${page}"]`);
    if (btn) btn.click();
    return true;
  }
  function selectMetric(metric) {
    setTimeout(() => {
      const tab = document.querySelector(`.chart-tab[data-metric="${metric}"]`);
      if (tab) tab.click();
    }, 100);
  }
  async function restartService(name) {
    try {
      const res = await fetch(`/api/services/${name}/restart`, { method: 'POST' });
      if (res.ok) showToast(`✅ ${name} restarted`);
      else showToast(`❌ Failed to restart ${name}`);
    } catch (_) { showToast(`❌ Failed to restart ${name}`); }
  }
  function deploy() {
    showToast('🚀 Run /deploy-saham in Claude Code');
  }
  async function healthCheck() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      showToast(`💚 Health: ${data.score}/100 — Grade ${data.grade}`);
    } catch (_) { showToast('❌ Health check failed'); }
  }
  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    showToast(`${theme === 'dark' ? '🌙' : '☀️'} Theme: ${theme}`);
  }
  function showToast(msg) {
    const toast = document.getElementById('alertToast');
    const text = document.getElementById('alertToastText');
    if (toast && text) {
      text.textContent = msg;
      toast.classList.remove('hidden');
      setTimeout(() => toast.classList.add('hidden'), 3000);
    }
  }

  // --- Palette UI ---
  function buildPalette() {
    const overlay = document.createElement('div');
    overlay.id = 'paletteOverlay';
    overlay.className = 'palette-overlay hidden';
    overlay.innerHTML = `
      <div class="palette-box">
        <div class="palette-input-wrap">
          <span class="palette-icon">⚡</span>
          <input type="text" class="palette-input" id="paletteInput" placeholder="Type a command..." autocomplete="off" spellcheck="false">
          <kbd class="palette-hint">esc</kbd>
        </div>
        <div class="palette-results" id="paletteResults"></div>
        <div class="palette-footer">
          <span>↑↓ navigate</span><span>↵ execute</span><span>esc close</span>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = document.getElementById('paletteInput');
    const results = document.getElementById('paletteResults');

    function open() {
      overlay.classList.remove('hidden');
      input.value = '';
      input.focus();
      renderResults(COMMANDS);
    }

    function close() {
      overlay.classList.add('hidden');
    }

    function renderResults(cmds) {
      if (cmds.length === 0) {
        results.innerHTML = '<div class="palette-empty">No matching commands</div>';
        return;
      }
      results.innerHTML = cmds.slice(0, 12).map((c, i) =>
        `<div class="palette-item${i === 0 ? ' active' : ''}" data-id="${c.id}" data-index="${i}">
          <span class="palette-item-icon">${c.icon}</span>
          <span class="palette-item-label">${highlight(c.label, input.value)}</span>
          <span class="palette-item-shortcut">${getShortcut(c)}</span>
        </div>`
      ).join('');
    }

    function highlight(text, query) {
      if (!query) return text;
      const idx = text.toLowerCase().indexOf(query.toLowerCase());
      if (idx === -1) return text;
      return text.slice(0, idx) + '<mark>' + text.slice(idx, idx + query.length) + '</mark>' + text.slice(idx + query.length);
    }

    function getShortcut(cmd) {
      if (cmd.id.startsWith('nav-')) return '→ go';
      if (cmd.id.startsWith('act-')) return '↵ run';
      if (cmd.id.startsWith('theme-')) return '⇄ switch';
    return '';
    }

    function getActiveIndex() {
      const el = results.querySelector('.palette-item.active');
      return el ? parseInt(el.dataset.index) : 0;
    }

    function setActive(index) {
      const items = results.querySelectorAll('.palette-item');
      items.forEach(el => el.classList.remove('active'));
      const target = results.querySelector(`[data-index="${index}"]`);
      if (target) {
        target.classList.add('active');
        target.scrollIntoView({ block: 'nearest' });
      }
    }

    function execute() {
      const active = results.querySelector('.palette-item.active');
      if (!active) return;
      const cmd = COMMANDS.find(c => c.id === active.dataset.id);
      if (cmd) {
        close();
        cmd.action();
      }
    }

    // Fuzzy filter
    input.addEventListener('input', () => {
      const q = input.value.toLowerCase().trim();
      if (!q) { renderResults(COMMANDS); return; }
      const filtered = COMMANDS.filter(c =>
        c.label.toLowerCase().includes(q) ||
        c.keywords.some(k => k.includes(q))
      );
      renderResults(filtered);
    });

    // Keyboard nav
    input.addEventListener('keydown', (e) => {
      const total = results.querySelectorAll('.palette-item').length;
      let idx = getActiveIndex();
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((idx + 1) % total); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((idx - 1 + total) % total); }
      else if (e.key === 'Enter') { e.preventDefault(); execute(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });

    // Click to execute
    results.addEventListener('click', (e) => {
      const item = e.target.closest('.palette-item');
      if (!item) return;
      const cmd = COMMANDS.find(c => c.id === item.dataset.id);
      if (cmd) { close(); cmd.action(); }
    });

    // Click overlay to close
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    // Global shortcut
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        open();
      }
    });
  }

  // Init on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildPalette);
  } else {
    buildPalette();
  }
})();
