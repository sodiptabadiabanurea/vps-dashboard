// Web Terminal - node-pty + Socket.IO
const os = require('os');
const config = require('./config');

const MAX_TERMINAL_SESSIONS = 2;
const MAX_INPUT_BYTES = 16 * 1024;
let activeSessions = 0;

function parseBasicCredentials(header) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return null;
    return { user: decoded.slice(0, separator), pass: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

function isAuthorized(socket) {
  const credentials = parseBasicCredentials(socket.handshake.headers.authorization);
  return Boolean(credentials && credentials.user === config.user && credentials.pass === config.pass);
}

function isAllowedOrigin(socket) {
  const origin = socket.handshake.headers.origin;
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const host = socket.handshake.headers.host;
    return host && originUrl.host === host;
  } catch {
    return false;
  }
}

function setupTerminal(io) {
  const terminalNs = io.of('/terminal');

  terminalNs.use((socket, next) => {
    if (!isAuthorized(socket)) return next(new Error('Authentication required'));
    if (!isAllowedOrigin(socket)) return next(new Error('Invalid origin'));
    if (activeSessions >= MAX_TERMINAL_SESSIONS) return next(new Error('Terminal capacity reached'));
    next();
  });

  terminalNs.on('connection', (socket) => {
    activeSessions += 1;
    let ptyProcess = null;

    try {
      const shell = process.env.SHELL || '/bin/bash';
      const pty = require('node-pty');
      ptyProcess = pty.spawn(shell, ['--noprofile', '--norc'], {
        name: 'xterm-256color',
        cols: 80,
        rows: 30,
        cwd: os.homedir(),
        env: { ...process.env, TERM: 'xterm-256color' },
      });

      ptyProcess.onData((data) => socket.emit('output', data));
      ptyProcess.onExit(({ exitCode }) => socket.emit('exit', exitCode));

      socket.on('input', (data) => {
        if (!ptyProcess || typeof data !== 'string') return;
        if (Buffer.byteLength(data, 'utf8') > MAX_INPUT_BYTES) return;
        ptyProcess.write(data);
      });

      socket.on('resize', ({ cols, rows } = {}) => {
        if (!ptyProcess) return;
        const safeCols = Number.isInteger(cols) ? Math.min(Math.max(cols, 20), 240) : 80;
        const safeRows = Number.isInteger(rows) ? Math.min(Math.max(rows, 5), 100) : 30;
        try { ptyProcess.resize(safeCols, safeRows); } catch (e) {}
      });

      socket.on('disconnect', () => {
        activeSessions = Math.max(0, activeSessions - 1);
        if (ptyProcess) {
          try { ptyProcess.kill(); } catch (e) {}
          ptyProcess = null;
        }
      });
    } catch (err) {
      activeSessions = Math.max(0, activeSessions - 1);
      socket.emit('output', `Error: ${err.message}\r\n`);
      socket.emit('exit', 1);
      socket.disconnect(true);
    }
  });
}

module.exports = { setupTerminal, parseBasicCredentials, isAuthorized };
