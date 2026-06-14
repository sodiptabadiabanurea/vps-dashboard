module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  hostname: process.env.HOST || '127.0.0.1',

  // Auth
  user: process.env.DASHBOARD_USER || 'admin',
  pass: process.env.DASHBOARD_PASS || 'changeme',

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
};
