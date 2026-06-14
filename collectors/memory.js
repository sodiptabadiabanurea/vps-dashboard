const fs = require('fs');

function parseMeminfo() {
  const content = fs.readFileSync('/proc/meminfo', 'utf8');
  const info = {};
  for (const line of content.split('\n')) {
    const match = line.match(/^(\w+):\s+(\d+)/);
    if (match) info[match[1]] = parseInt(match[2], 10); // in kB
  }
  return info;
}

module.exports = async function memoryCollector() {
  const info = parseMeminfo();

  const ramTotal = info.MemTotal || 0;
  const ramAvailable = info.MemAvailable || info.MemFree || 0;
  const ramUsed = ramTotal - ramAvailable;

  const swapTotal = info.SwapTotal || 0;
  const swapFree = info.SwapFree || 0;
  const swapUsed = swapTotal - swapFree;

  return {
    ram: {
      total: ramTotal * 1024,     // convert to bytes
      used: ramUsed * 1024,
      percent: ramTotal > 0 ? Math.round((ramUsed / ramTotal) * 1000) / 10 : 0,
    },
    swap: {
      total: swapTotal * 1024,
      used: swapUsed * 1024,
      percent: swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 1000) / 10 : 0,
    },
  };
};
