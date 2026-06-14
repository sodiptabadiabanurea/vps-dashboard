const config = require('../config');

async function send(text) {
  if (!config.telegramToken || !config.telegramChatId) return;

  const url = `https://api.telegram.org/bot${config.telegramToken}/sendMessage`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text,
      parse_mode: 'Markdown',
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API error ${res.status}: ${body}`);
  }

  return res.json();
}

module.exports = { send };
