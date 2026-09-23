// Registers the Vercel URL as the bot's webhook.
// Usage: npm run set-webhook -- https://your-project.vercel.app

import { callTelegram } from '../lib/telegram.js';
import { getTelegramConfig } from '../lib/config.js';

const base = process.argv[2];
if (!base || !/^https:\/\//.test(base)) {
  console.error('Usage: npm run set-webhook -- https://your-project.vercel.app');
  process.exit(1);
}

const { botToken, webhookSecret } = getTelegramConfig();
const url = `${base.replace(/\/+$/, '')}/api/telegram`;

await callTelegram(botToken, 'setWebhook', {
  url,
  secret_token: webhookSecret,
  allowed_updates: ['message'],
  drop_pending_updates: true,
});

const info = await callTelegram(botToken, 'getWebhookInfo', {});
console.log(`Webhook set to ${info.url}`);
if (info.last_error_message) console.log(`Last error reported by Telegram: ${info.last_error_message}`);
