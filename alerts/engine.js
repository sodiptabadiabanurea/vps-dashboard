const config = require('../config');
const telegram = require('./telegram');

let stmts = null;
let io = null;
let alertConfigs = {};
let lastAlertTime = {};

function init(dbStmts, socketIo) {
  stmts = dbStmts;
  io = socketIo;
  reloadConfig();
}

function reloadConfig() {
  if (!stmts) return;
  const rows = stmts.getAlertConfig.all();
  alertConfigs = {};
  for (const row of rows) {
    alertConfigs[row.type] = {
      enabled: row.enabled === 1,
      threshold: row.threshold,
      cooldown: row.cooldown,
    };
  }
}

function check(metrics) {
  const checks = [
    { type: 'cpu', value: metrics.cpu, label: 'CPU' },
    { type: 'ram', value: metrics.ram_percent, label: 'RAM' },
    { type: 'swap', value: metrics.swap_percent, label: 'Swap' },
  ];

  for (const { type, value, label } of checks) {
    const cfg = alertConfigs[type];
    if (!cfg || !cfg.enabled) continue;
    if (value < cfg.threshold) continue;

    const now = Math.floor(Date.now() / 1000);
    const lastTime = lastAlertTime[type] || 0;
    if (now - lastTime < cfg.cooldown) continue;

    lastAlertTime[type] = now;

    const message = `⚠️ VPS Alert: ${label} at ${value}% (threshold: ${cfg.threshold}%)\nServer: kakibaabu\nTime: ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`;

    // Store alert
    if (stmts) {
      stmts.insertAlert.run(now, type, message, value, cfg.threshold);
    }

    // Emit via Socket.IO
    if (io) {
      io.emit('alert', { type, message, value, threshold: cfg.threshold, ts: now });
    }

    // Send Telegram
    telegram.send(message).catch(err => {
      console.error('Telegram send error:', err.message);
    });
  }
}

module.exports = { init, reloadConfig, check };
