// Runs one note through the real webhook pipeline (handleUpdate) with Telegram faked.
// Gemini calls go to the real API unless `gemini` is given, which fakes the responses.

import { handleUpdate } from '../api/telegram.js';

const TEST_CONFIG = { botToken: 'TEST_TOKEN', webhookSecret: 'test', allowedUserIds: [] };

export function geminiText(text) {
  return new Response(
    JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

// Returns { sent, geminiCalls, gate }:
//   sent         texts sent to Telegram with sendMessage
//   geminiCalls  'score' or 'draft' per Gemini request, in order
//   gate         { score, reason, decision } parsed from the [gate] log line, or null
export async function runNote(text, { gemini } = {}) {
  const sent = [];
  const geminiCalls = [];
  const logs = [];
  const realFetch = globalThis.fetch;
  const realLog = { log: console.log, warn: console.warn, error: console.error };

  globalThis.fetch = async (url, opts) => {
    url = String(url);
    if (url.startsWith('https://api.telegram.org/')) {
      if (url.endsWith('/sendMessage')) sent.push(JSON.parse(opts.body).text);
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      const body = JSON.parse(opts.body);
      const kind = body.generationConfig?.responseMimeType === 'application/json' ? 'score' : 'draft';
      geminiCalls.push(kind);
      return gemini ? gemini(kind, body) : realFetch(url, opts);
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  };
  for (const level of Object.keys(realLog)) {
    console[level] = (...args) => {
      logs.push(args.map(String).join(' '));
      realLog[level](...args);
    };
  }

  const update = {
    update_id: 1,
    message: { message_id: 1, chat: { id: 1 }, from: { id: 1 }, text },
  };
  try {
    await handleUpdate(update, TEST_CONFIG);
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(console, realLog);
  }

  const line = logs.find((l) => l.startsWith('[gate]'));
  const m = line?.match(/score=(\d+) reason=(".*") decision=(\w+)/);
  const gate = m ? { score: Number(m[1]), reason: JSON.parse(m[2]), decision: m[3] } : null;
  return { sent, geminiCalls, gate };
}
