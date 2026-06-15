// Smart Alert Engine — pattern detection, suppression, grouping, escalation
const config = require('../config');
const telegram = require('./telegram');

let stmts = null;
let io = null;
let alertConfigs = {};
let lastAlertTime = {};
let suppressedCount = {};    // type -> {count, first_seen, last_seen, reason}
let groupBuffer = {};        // type -> {alerts[], timer}

const GROUP_WINDOW = 600;    // 10 min — group alerts within this window
const PATTERN_WINDOW = 300;  // ±5 min — considered "same time" for pattern
const PATTERN_MIN_DAYS = 2;  // need 2+ occurrences to establish a pattern
const DIGEST_INTERVAL = 3600; // hourly digest of suppressed alerts

function init(dbStmts, socketIo) {
  stmts = dbStmts;
  io = socketIo;
  reloadConfig();
  startDigestTimer();
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

// --- Pattern Detection ---
function isRecurringPattern(type, now) {
  if (!stmts) return false;
  // Look at last 7 days of alerts for this type
  const since = now - 7 * 86400;
  const rows = stmts.getAlertsByTypeSince.all(type, since);
  if (rows.length < PATTERN_MIN_DAYS) return false;

  const d = new Date(now * 1000);
  const currentMinute = d.getHours() * 60 + d.getMinutes();
  const currentDay = d.getDay();

  // Count how many past alerts happened at similar time (±5 min) on same weekday
  let matches = 0;
  for (const row of rows) {
    const rd = new Date(row.ts * 1000);
    const rowMinute = rd.getHours() * 60 + rd.getMinutes();
    if (rd.getDay() === currentDay && Math.abs(rowMinute - currentMinute) <= PATTERN_WINDOW / 60) {
      matches++;
    }
  }
  return matches >= PATTERN_MIN_DAYS;
}

// --- Grouping ---
function flushGroup(type) {
  const group = groupBuffer[type];
  if (!group || group.alerts.length === 0) return;

  const alerts = group.alerts;
  const first = alerts[0];
  const last = alerts[alerts.length - 1];
  const maxVal = Math.max(...alerts.map(a => a.value));

  const serverName = config.serverName || 'VPS';
  const label = first.label;
  const threshold = first.threshold;
  const timeStr = new Date(first.ts * 1000).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  if (alerts.length === 1) {
    // Single alert — send normally
    const message = `⚠️ VPS Alert: ${label} at ${maxVal}% (threshold: ${threshold}%)\nServer: ${serverName}\nTime: ${timeStr} WIB`;
    emitAndStore(type, message, maxVal, threshold, first.ts);
  } else {
    // Grouped alert
    const duration = last.ts - first.ts;
    const durationStr = duration < 60 ? `${duration}s` : `${Math.round(duration / 60)}min`;
    const message = `⚠️ VPS Alert: ${label} spiked ${alerts.length}x in ${durationStr} (peak: ${maxVal}%, threshold: ${threshold}%)\nServer: ${serverName}\nTime: ${timeStr} WIB`;
    emitAndStore(type, message, maxVal, threshold, first.ts, { count: alerts.length, duration_sec: duration });
  }

  clearTimeout(group.timer);
  delete groupBuffer[type];
}

function emitAndStore(type, message, value, threshold, ts, extraMeta) {
  const now = ts || Math.floor(Date.now() / 1000);

  // Store in DB
  if (stmts) {
    stmts.insertAlert.run(now, type, message, value, threshold);
  }

  // Emit via Socket.IO
  if (io) {
    io.emit('alert', { type, message, value, threshold, ts: now, ...(extraMeta || {}) });
  }

  // Send Telegram
  telegram.send(message).catch(err => {
    console.error('Telegram send error:', err.message);
  });

  lastAlertTime[type] = now;
}

// --- Suppression tracking ---
function suppressAlert(type, label, value, threshold, reason) {
  if (!suppressedCount[type]) {
    suppressedCount[type] = { count: 0, first_seen: Date.now(), last_seen: Date.now(), reason, label, threshold };
  }
  suppressedCount[type].count++;
  suppressedCount[type].last_seen = Date.now();

  // Emit suppressed event (silent — for timeline only)
  if (io) {
    io.emit('alert-suppressed', { type, value, threshold, reason, ts: Math.floor(Date.now() / 1000) });
  }
}

// --- Digest ---
function sendDigest() {
  const now = Date.now();
  for (const [type, info] of Object.entries(suppressedCount)) {
    if (info.count === 0) continue;
    const duration = Math.round((info.last_seen - info.first_seen) / 60000);
    if (info.count >= 3 || duration >= 30) {
      const msg = `🔕 ${info.count} ${info.label} alerts suppressed in ${duration}min\nReason: ${info.reason}\nServer: ${config.serverName || 'VPS'}`;
      telegram.send(msg).catch(() => {});
      if (io) {
        io.emit('alert', { type: 'digest', message: msg, ts: Math.floor(now / 1000) });
      }
    }
    suppressedCount[type] = { count: 0, first_seen: now, last_seen: now, reason: info.reason, label: info.label, threshold: info.threshold };
  }
}

function startDigestTimer() {
  setInterval(sendDigest, DIGEST_INTERVAL * 1000);
}

// --- Main Check ---
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

    // Cooldown check
    const lastTime = lastAlertTime[type] || 0;
    if (now - lastTime < cfg.cooldown) {
      // Within cooldown — count as suppressed (cooldown suppression)
      suppressAlert(type, label, value, cfg.threshold, 'cooldown');
      continue;
    }

    // Pattern check — is this a recurring expected spike?
    if (isRecurringPattern(type, now)) {
      const d = new Date(now * 1000);
      const timeLabel = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      suppressAlert(type, label, value, cfg.threshold, `recurring daily pattern at ${timeLabel}`);
      continue;
    }

    // Group: add to group buffer
    if (!groupBuffer[type]) {
      groupBuffer[type] = { alerts: [], timer: null };
    }
    groupBuffer[type].alerts.push({ ts: now, value, label, threshold: cfg.threshold });

    // Start group window timer
    if (!groupBuffer[type].timer) {
      groupBuffer[type].timer = setTimeout(() => flushGroup(type), GROUP_WINDOW * 1000);
    }

    // If too many in group, flush early
    if (groupBuffer[type].alerts.length >= 5) {
      clearTimeout(groupBuffer[type].timer);
      flushGroup(type);
    }
  }
}

function getSuppressionStats() {
  const stats = {};
  for (const [type, info] of Object.entries(suppressedCount)) {
    stats[type] = { ...info };
  }
  return stats;
}

module.exports = { init, reloadConfig, check, getSuppressionStats, flushGroup, sendDigest };
