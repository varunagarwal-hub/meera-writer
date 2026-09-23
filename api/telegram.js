// Vercel serverless function: the Telegram webhook.
// Flow: Telegram → this endpoint → Gemini (with voice-skill.txt) → back to the same chat.

import { waitUntil } from '@vercel/functions';
import { ConfigError, getMaxNoteChars, getTelegramConfig } from '../lib/config.js';
import { GeminiError, generateLinkedInPost } from '../lib/gemini.js';
import { sendText, sendTyping } from '../lib/telegram.js';
import { VoiceFileError } from '../lib/voice.js';

const HELP_TEXT =
  'Send me your raw notes or idea as a text message and I will reply with a LinkedIn draft. ' +
  'Send another note any time for a new draft.';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'meera-writer' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  let config;
  try {
    config = getTelegramConfig();
  } catch (err) {
    console.error('[config]', err.message);
    return res.status(500).json({ ok: false, error: 'Server is not configured' });
  }

  // Telegram echoes the secret we registered with setWebhook. Anything else is not Telegram.
  if (req.headers['x-telegram-bot-api-secret-token'] !== config.webhookSecret) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const update = parseBody(req.body);
  if (!update || typeof update.update_id !== 'number') {
    return res.status(400).json({ ok: false, error: 'Invalid Telegram update' });
  }

  // Acknowledge immediately so Telegram doesn't time out and resend the update
  // (which would produce duplicate drafts). The work continues after the response.
  waitUntil(
    handleUpdate(update, config).catch((err) => console.error('[unhandled]', err)),
  );
  return res.status(200).json({ ok: true });
}

function parseBody(body) {
  if (body && typeof body === 'object') return body;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return null;
}

async function handleUpdate(update, config) {
  const message = update.message;
  // Edited messages, channel posts, button presses etc. are ignored.
  if (!message?.chat?.id) return;

  const chatId = message.chat.id;
  const userId = String(message.from?.id ?? '');
  const reply = (text) => sendText(config.botToken, chatId, text, { replyTo: message.message_id });
  const text = (message.text ?? message.caption ?? '').trim();

  // /id works for everyone so the owner can find Meera's ID for the allowlist.
  if (/^\/id(@\w+)?$/i.test(text)) {
    return reply(`Your Telegram user ID is ${userId}.`);
  }

  if (config.allowedUserIds.length && !config.allowedUserIds.includes(userId)) {
    console.warn(`[auth] rejected user ${userId}`);
    return reply('Sorry, this bot is private.');
  }

  if (/^\/(start|help)(@\w+)?$/i.test(text)) {
    return reply(HELP_TEXT);
  }

  if (!text) {
    return reply('I can only work with text. Please send your notes as a text message.');
  }

  const maxChars = getMaxNoteChars();
  if (text.length > maxChars) {
    return reply(
      `That note is ${text.length} characters, which is over the ${maxChars}-character limit. ` +
        'Please shorten it or send the core idea on its own.',
    );
  }

  await sendTyping(config.botToken, chatId);

  let draft;
  try {
    draft = await generateLinkedInPost(text);
  } catch (err) {
    console.error('[generate]', err);
    return reply(userFacingError(err));
  }

  try {
    await reply(draft);
  } catch (err) {
    console.error('[telegram send]', err);
  }
}

function userFacingError(err) {
  if (err instanceof GeminiError && err.userMessage) return err.userMessage;
  if (err instanceof ConfigError) {
    return 'The bot is missing a setting on the server, so I could not write the draft. The bot owner needs to check the environment variables.';
  }
  if (err instanceof VoiceFileError) {
    return 'I could not load the writing instructions, so I did not write a draft. The bot owner needs to check voice-skill.txt.';
  }
  return 'Something went wrong while writing the draft. Please send the note again in a minute.';
}
