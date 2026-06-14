const fs = require('fs');

let prevIdle = 0;
let prevTotal = 0;

module.exports = async function cpuCollector() {
  const stat = fs.readFileSync('/proc/stat', 'utf8');
  const line = stat.split('\n')[0]; // cpu  user nice system idle iowait irq softirq steal
  const parts = line.trim().split(/\s+/).slice(1).map(Number);

  const idle = parts[3] + parts[4]; // idle + iowait
  const total = parts.reduce((a, b) => a + b, 0);

  const diffIdle = idle - prevIdle;
  const diffTotal = total - prevTotal;

  prevIdle = idle;
  prevTotal = total;

  const usage = diffTotal > 0 ? ((diffTotal - diffIdle) / diffTotal) * 100 : 0;

  return {
    usage: Math.round(usage * 10) / 10,
    cores: parts.length / 4, // approximate
  };
};
