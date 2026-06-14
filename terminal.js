// Web Terminal - node-pty + Socket.IO
const os = require('os');

function setupTerminal(io) {
  const terminalNs = io.of('/terminal');

  terminalNs.on('connection', (socket) => {
    let ptyProcess = null;

    try {
      const shell = process.env.SHELL || '/bin/bash';
      const pty = require('node-pty');
      ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 30,
        cwd: os.homedir(),
        env: { ...process.env, TERM: 'xterm-256color' },
      });

      ptyProcess.onData((data) => {
        socket.emit('output', data);
      });

      ptyProcess.onExit(({ exitCode }) => {
        socket.emit('exit', exitCode);
      });

      socket.on('input', (data) => {
        if (ptyProcess) ptyProcess.write(data);
      });

      socket.on('resize', ({ cols, rows }) => {
        if (ptyProcess) {
          try { ptyProcess.resize(cols, rows); } catch (e) {}
        }
      });

      socket.on('disconnect', () => {
        if (ptyProcess) {
          try { ptyProcess.kill(); } catch (e) {}
          ptyProcess = null;
        }
      });
    } catch (err) {
      socket.emit('output', `Error: ${err.message}\r\n`);
      socket.emit('exit', 1);
    }
  });
}

module.exports = { setupTerminal };
