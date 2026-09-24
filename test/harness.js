// Runs one note through the real webhook pipeline (handleUpdate).
//   gemini(kind, body)  fakes Gemini responses; omit for real Gemini calls
//   news(url, opts)     fakes Google News responses; omit for real fetches
//   telegram            { botToken, chatId } to send to real Telegram; omit to fake it

import { handleUpdate } from '../api/telegram.js';

export function geminiText(text) {
  return new Response(
    JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

export function rssResponse(itemsXml) {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>test</title>${itemsXml}</channel></rss>`,
    { status: 200, headers: { 'Content-Type': 'application/xml' } },
  );
}

function geminiKind(body) {
  const props = body.generationConfig?.responseSchema?.properties ?? {};
  if ('score' in props) return 'score';
  if ('search_phrase' in props) return 'keywords';
  return 'draft';
}

// Returns { sent, geminiCalls, newsUrls, draftPrompt, logs, gate, news }:
//   sent         texts sent with sendMessage, in order
//   geminiCalls  'score' | 'keywords' | 'draft' per Gemini request
//   draftPrompt  the user message of the (last) drafting call
//   gate         { score, reason, decision } from the [gate] log line
//   news         { searchPhrase, article, usedNews, flag } from the [news] log lines
export async function runNote(text, { gemini, news, telegram } = {}) {
  const sent = [];
  const geminiCalls = [];
  const newsUrls = [];
  const logs = [];
  let draftPrompt;
  const realFetch = globalThis.fetch;
  const realLog = { log: console.log, warn: console.warn, error: console.error };

  globalThis.fetch = async (url, opts) => {
    url = String(url);
    if (url.startsWith('https://api.telegram.org/')) {
      if (url.endsWith('/sendMessage')) sent.push(JSON.parse(opts.body).text);
      if (telegram) return realFetch(url, opts);
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      const body = JSON.parse(opts.body);
      const kind = geminiKind(body);
      geminiCalls.push(kind);
      if (kind === 'draft') draftPrompt = body.contents[0].parts[0].text;
      return gemini ? gemini(kind, body) : realFetch(url, opts);
    }
    if (url.startsWith('https://news.google.com/')) {
      newsUrls.push(url);
      return news ? news(url, opts) : realFetch(url, opts);
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  };
  for (const level of Object.keys(realLog)) {
    console[level] = (...args) => {
      logs.push(args.map(String).join(' '));
      realLog[level](...args);
    };
  }

  const chatId = telegram?.chatId ?? 1;
  const config = {
    botToken: telegram?.botToken ?? 'TEST_TOKEN',
    webhookSecret: 'test',
    allowedUserIds: [],
  };
  const update = {
    update_id: 1,
    message: { message_id: 1, chat: { id: chatId }, from: { id: chatId }, text },
  };
  try {
    await handleUpdate(update, config);
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(console, realLog);
  }

  const gateLine = logs.find((l) => l.startsWith('[gate]'));
  const g = gateLine?.match(/score=(\d+) reason=(".*") decision=(\w+)/);
  const gate = g ? { score: Number(g[1]), reason: JSON.parse(g[2]), decision: g[3] } : null;

  const findLine = logs.find((l) => l.startsWith('[news]') && l.includes('search_phrase='));
  const usedLine = logs.find((l) => l.startsWith('[news]') && l.includes('used_news='));
  const phrase = findLine?.match(/search_phrase=(".*?"|none) article=/)?.[1];
  const article = findLine?.match(/article=(".*?"|none)(?: |$)/)?.[1];
  const newsLog = {
    searchPhrase: phrase && phrase !== 'none' ? JSON.parse(phrase) : null,
    article: article && article !== 'none' ? JSON.parse(article) : null,
    usedNews: usedLine?.match(/used_news=(\S+)/)?.[1] ?? null,
    flag: usedLine?.match(/flag=(\S+)/)?.[1] ?? null,
  };

  return { sent, geminiCalls, newsUrls, draftPrompt, logs, gate, news: newsLog };
}
