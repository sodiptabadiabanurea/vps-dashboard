// Notification Channels - Discord, Slack, Email, Telegram
const https = require('https');
const http = require('http');

async function sendDiscord(webhookUrl, message) {
  if (!webhookUrl) return;
  const url = new URL(webhookUrl);
  const options = {
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    req.write(JSON.stringify({ content: message }));
    req.end();
  });
}

async function sendSlack(webhookUrl, message) {
  if (!webhookUrl) return;
  const url = new URL(webhookUrl);
  const options = {
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    req.write(JSON.stringify({ text: message }));
    req.end();
  });
}

async function sendTelegram(token, chatId, message) {
  if (!token || !chatId) return;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message }),
  });
}

function setupNotificationRoutes(app, requireAuth, stmts, auditLog) {
  // Get notification config
  app.get('/api/notifications/config', requireAuth, (req, res) => {
    res.json(stmts.getNotifConfig.all());
  });

  // Update notification channel
  app.put('/api/notifications/:channel', requireAuth, (req, res) => {
    const { channel } = req.params;
    const { enabled, webhook_url } = req.body;
    stmts.updateNotifConfig.run(enabled ? 1 : 0, webhook_url || '', channel);
    if (auditLog) auditLog('notif_update', `Updated ${channel}`);
    res.json({ ok: true });
  });

  // Test notification
  app.post('/api/notifications/:channel/test', requireAuth, async (req, res) => {
    const { channel } = req.params;
    const config = stmts.getNotifConfigByType.get(channel);
    if (!config) return res.status(404).json({ error: 'Channel not found' });

    const message = '🔔 Test notification from VPS Dashboard - kakibaabu';

    try {
      if (channel === 'discord') await sendDiscord(config.webhook_url, message);
      else if (channel === 'slack') await sendSlack(config.webhook_url, message);
      else if (channel === 'telegram') {
        const parts = config.webhook_url.split(':');
        if (parts.length === 2) await sendTelegram(parts[0], parts[1], message);
      }
      res.json({ ok: true });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });
}

async function notifyAll(stmts, message) {
  const channels = stmts.getNotifConfig.all().filter(c => c.enabled);
  for (const ch of channels) {
    try {
      if (ch.type === 'discord') await sendDiscord(ch.webhook_url, message);
      else if (ch.type === 'slack') await sendSlack(ch.webhook_url, message);
      else if (ch.type === 'telegram') {
        const parts = ch.webhook_url.split(':');
        if (parts.length === 2) await sendTelegram(parts[0], parts[1], message);
      }
    } catch (err) {
      console.error(`Notification ${ch.type} error:`, err.message);
    }
  }
}

module.exports = { setupNotificationRoutes, notifyAll, sendDiscord, sendSlack, sendTelegram };
