const crypto = require('crypto');

// Warn and generate random password if DASHBOARD_PASS not set
let pass = process.env.DASHBOARD_PASS;
if (!pass) {
  pass = crypto.randomBytes(16).toString('base64url');
  console.warn('\x1b[33m⚠️  DASHBOARD_PASS not set. Generated random password:\x1b[0m');
  console.warn(`\x1b[36m   User: ${process.env.DASHBOARD_USER || 'admin'}\x1b[0m`);
  console.warn(`\x1b[36m   Pass: ${pass}\x1b[0m`);
  console.warn('\x1b[33m   Set DASHBOARD_PASS env var to use a fixed password.\x1b[0m\n');
}

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  hostname: process.env.HOST || '127.0.0.1',

  // Auth
  user: process.env.DASHBOARD_USER || 'admin',
  pass,

  // Collection intervals (ms)
  metricsInterval: 2000,
  processesInterval: 5000,
  servicesInterval: 10000,
  historyWriteInterval: 60000,

  // SQLite
  dbPath: process.env.DB_PATH || '/var/lib/vps-dashboard/dashboard.db',

  // Alert defaults
  alerts: {
    cpu:  { enabled: true, threshold: 90, cooldown: 300 },
    ram:  { enabled: true, threshold: 85, cooldown: 300 },
    disk: { enabled: true, threshold: 90, cooldown: 600 },
    swap: { enabled: true, threshold: 50, cooldown: 300 },
  },

  // Telegram
  telegramToken: process.env.TELEGRAM_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',

  // Network interface to monitor
  networkInterface: process.env.NET_IFACE || 'enp0s6',

  // Services to monitor
  services: ['ssh', 'fail2ban', 'tor', 'nginx'],

  // History retention (days)
  historyRetentionDays: 90,

  // SSL domains to monitor (comma-separated env var or defaults)
  sslDomains: process.env.SSL_DOMAINS
    ? process.env.SSL_DOMAINS.split(',').map(d => d.trim()).filter(Boolean)
    : ['kakibaabu.duckdns.org', 'sahamradar.com'],

  // Server name for alerts/notifications
  serverName: process.env.SERVER_NAME || 'VPS',
};
