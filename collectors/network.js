const fs = require('fs');
const { execSync } = require('child_process');

let prevRx = 0;
let prevTx = 0;
let prevTime = Date.now();

module.exports = async function networkCollector(iface) {
  const devData = fs.readFileSync('/proc/net/dev', 'utf8');
  const lines = devData.split('\n');

  let rxBytes = 0;
  let txBytes = 0;

  for (const line of lines) {
    const match = line.trim().match(new RegExp(`^${iface}:\\s*(\\d+)\\s+\\d+\\s+\\d+\\s+\\d+\\s+\\d+\\s+\\d+\\s+\\d+\\s+\\d+\\s+(\\d+)`));
    if (match) {
      rxBytes = parseInt(match[1], 10);
      txBytes = parseInt(match[2], 10);
      break;
    }
  }

  const now = Date.now();
  const elapsed = (now - prevTime) / 1000; // seconds

  const rxSpeed = elapsed > 0 ? (rxBytes - prevRx) / elapsed : 0;
  const txSpeed = elapsed > 0 ? (txBytes - prevTx) / elapsed : 0;

  prevRx = rxBytes;
  prevTx = txBytes;
  prevTime = now;

  // TCP connections count
  let tcpConnections = 0;
  try {
    const ss = execSync('ss -t state established 2>/dev/null | tail -n +2 | wc -l', { encoding: 'utf8' });
    tcpConnections = parseInt(ss.trim(), 10) || 0;
  } catch (err) {
    // ignore
  }

  return {
    rx_bytes: rxBytes,
    tx_bytes: txBytes,
    rx_speed: Math.max(0, Math.round(rxSpeed)),
    tx_speed: Math.max(0, Math.round(txSpeed)),
    tcp_connections: tcpConnections,
  };
};
