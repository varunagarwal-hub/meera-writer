// Telegram Bot API client. Knows nothing about Gemini.

const TELEGRAM_LIMIT = 4096; // max characters per Telegram message

export async function callTelegram(botToken, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    // Error text comes from Telegram; the URL (which contains the token) is not logged.
    throw new Error(`Telegram ${method} failed (${res.status}): ${data.description ?? 'unknown error'}`);
  }
  return data.result;
}

// Sends plain text (no parse_mode, so characters like * or _ in a draft can't break it),
// split into several messages if it exceeds Telegram's limit.
export async function sendText(botToken, chatId, text, { replyTo } = {}) {
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    const payload = { chat_id: chatId, text: chunks[i], link_preview_options: { is_disabled: true } };
    if (i === 0 && replyTo) {
      payload.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
    }
    await callTelegram(botToken, 'sendMessage', payload);
  }
}

export async function sendTyping(botToken, chatId) {
  try {
    await callTelegram(botToken, 'sendChatAction', { chat_id: chatId, action: 'typing' });
  } catch {
    // Cosmetic only; never fail the request over it.
  }
}

// Splits on paragraph breaks, then line breaks, then spaces, so a post is never cut mid-word.
export function splitMessage(text, limit = TELEGRAM_LIMIT) {
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf('\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
