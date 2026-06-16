// Terminal - xterm.js integration
(function() {
  let term = null;
  let termSocket = null;

  function initTerminal() {
    if (term) {
      if (termSocket && !termSocket.connected) termSocket.connect();
      term.focus();
      return;
    }

    const container = document.getElementById('terminal-container');
    if (!container) return;

    // Load xterm.js dynamically
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css';
    document.head.appendChild(link);

    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5/lib/xterm.min.js';
    script.onload = () => {
      const fitAddon = document.createElement('script');
      fitAddon.src = 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10/lib/addon-fit.min.js';
      fitAddon.onload = () => setupXterm(container);
      fitAddon.onerror = () => {
        container.textContent = 'Failed to load terminal fit addon. Refresh the page.';
      };
      document.head.appendChild(fitAddon);
    };
    script.onerror = () => {
      container.textContent = 'Failed to load terminal library. Refresh the page.';
    };
    document.head.appendChild(script);
  }

  async function setupXterm(container) {
    const { Terminal } = window;
    const { FitAddon } = window.FitAddon || {};

    term = new Terminal({
      theme: {
        background: '#0a0a0a',
        foreground: '#e0e0e0',
        cursor: '#00ff88',
        cursorAccent: '#0a0a0a',
        selectionBackground: '#3b82f644',
        black: '#0a0a0a',
        red: '#ff0055',
        green: '#00ff88',
        yellow: '#f59e0b',
        blue: '#3b82f6',
        magenta: '#ff00ff',
        cyan: '#00ffff',
        white: '#e0e0e0',
      },
      fontSize: 14,
      fontFamily: "'SF Mono', 'Consolas', 'Courier New', monospace",
      cursorBlink: true,
      rows: 30,
    });

    if (FitAddon) {
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      fit.fit();
      window.addEventListener('resize', () => fit.fit());
    } else {
      term.open(container);
    }

    term.write('Connecting to server...\r\n');

    // Get auth token — wait for it if not yet available
    let token = typeof getBasicAuthToken === 'function' ? getBasicAuthToken() : null;
    if (!token) {
      try {
        const res = await fetch('/api/session');
        if (res.ok) {
          const data = await res.json();
          token = data.token;
        }
      } catch (e) {}
    }

    if (!token) {
      term.write('\r\n\x1b[31mMissing auth token. Refresh this page, then open Terminal again.\x1b[0m\r\n');
      return;
    }

    const authOpts = {
      auth: { token },
      forceNew: true,
      timeout: 8000,
      reconnectionAttempts: 3,
    };

    termSocket = io('/terminal', authOpts);

    let receivedOutput = false;

    termSocket.on('connect', () => {
      term.write('\r\n\x1b[32mConnected. Starting shell...\x1b[0m\r\n');
      // Some mobile browsers miss/paint over the first PTY prompt. Send a safe
      // newline if no output appears shortly after connect to force a prompt.
      setTimeout(() => {
        if (!receivedOutput && termSocket && termSocket.connected) {
          termSocket.emit('input', '\r');
        }
      }, 1200);
    });

    termSocket.on('output', (data) => {
      receivedOutput = true;
      term.write(data);
    });
    termSocket.on('exit', () => term.write('\r\n[Process exited]\r\n'));
    termSocket.on('connect_error', (err) => {
      term.write(`\r\n\x1b[31mConnection error: ${err.message}\x1b[0m\r\n`);
    });
    termSocket.on('disconnect', (reason) => {
      if (reason !== 'io client disconnect') {
        term.write(`\r\n\x1b[33mDisconnected: ${reason}\x1b[0m\r\n`);
      }
    });

    term.onData((data) => termSocket.emit('input', data));
    term.onResize(({ cols, rows }) => termSocket.emit('resize', { cols, rows }));

  }

  window.initTerminal = initTerminal;
})();
