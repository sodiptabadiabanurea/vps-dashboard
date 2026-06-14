const { execSync } = require('child_process');

module.exports = async function processesCollector() {
  try {
    const ps = execSync(
      'ps aux --sort=-%cpu | head -16 | tail -15',
      { encoding: 'utf8' }
    );

    const processes = [];
    for (const line of ps.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;

      const pid = parseInt(parts[1], 10);
      const cpu = parseFloat(parts[2]);
      const mem = parseFloat(parts[3]);
      const rss = parseInt(parts[5], 10) * 1024; // kB to bytes
      const cmd = parts.slice(10).join(' ');
      const name = parts[10].split('/').pop();

      // Get process uptime
      let uptime = '';
      try {
        const etimes = execSync(`ps -p ${pid} -o etimes= 2>/dev/null`, { encoding: 'utf8' });
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
        const stat = execSync(`cat /proc/${pid}/stat 2>/dev/null`, { encoding: 'utf8' });
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
