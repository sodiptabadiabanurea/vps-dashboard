// Terminal - xterm.js integration
(function() {
  let term = null;
  let termSocket = null;

  function initTerminal() {
    if (term) return;

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
      document.head.appendChild(fitAddon);
    };
    document.head.appendChild(script);
  }

  function setupXterm(container) {
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

    // Connect to terminal socket
    termSocket = io('/terminal');

    termSocket.on('output', (data) => term.write(data));
    termSocket.on('exit', () => term.write('\r\n[Process exited]\r\n'));

    term.onData((data) => termSocket.emit('input', data));
    term.onResize(({ cols, rows }) => termSocket.emit('resize', { cols, rows }));

    term.write('Connecting to server...\r\n');
  }

  window.initTerminal = initTerminal;
})();
