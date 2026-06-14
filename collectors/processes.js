const { exec } = require('child_process');

function runCmd(cmd, timeout = 10000) {
  return new Promise((resolve) => {
    exec(cmd, { encoding: 'utf8', timeout }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

module.exports = async function processesCollector() {
  try {
    const ps = await runCmd('ps aux --sort=-%cpu | head -16 | tail -15');

    const processes = [];
    for (const line of ps.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;

      const pid = parseInt(parts[1], 10);
      const cpu = parseFloat(parts[2]);
      const mem = parseFloat(parts[3]);
      const rss = parseInt(parts[5], 10) * 1024;
      const cmd = parts.slice(10).join(' ');
      const name = parts[10].split('/').pop();

      // Get process uptime
      let uptime = '';
      try {
        const etimes = await runCmd(`ps -p ${pid} -o etimes= 2>/dev/null`);
        const seconds = parseInt(etimes.trim(), 10);
        if (!isNaN(seconds)) {
          const h = Math.floor(seconds / 3600);
          const m = Math.floor((seconds % 3600) / 60);
          const s = seconds % 60;
          uptime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        }
      } catch (err) {
        // ignore
      }

      // Get process state
      let state = 'Sleeping';
      try {
        const stat = await runCmd(`cat /proc/${pid}/stat 2>/dev/null`);
        const stateChar = stat.match(/\)\s([A-Z])/);
        if (stateChar) {
          const states = { R: 'Running', S: 'Sleeping', D: 'Disk Sleep', Z: 'Zombie', T: 'Stopped' };
          state = states[stateChar[1]] || 'Unknown';
        }
      } catch (err) {
        // ignore
      }

      processes.push({ pid, name, cpu, mem, rss, state, uptime, cmd });
    }

    return processes;
  } catch (err) {
    return [];
  }
};
