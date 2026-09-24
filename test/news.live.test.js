// End to end with real Gemini and real Google News. Skipped unless GEMINI_API_KEY is set.
// If TELEGRAM_BOT_TOKEN and TEST_TELEGRAM_CHAT_ID are also set, the draft is really sent
// to that chat; otherwise Telegram is faked and the message is only captured.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runNote } from './harness.js';

const live = { skip: !process.env.GEMINI_API_KEY && 'GEMINI_API_KEY not set' };
const telegram =
  process.env.TELEGRAM_BOT_TOKEN && process.env.TEST_TELEGRAM_CHAT_ID
    ? { botToken: process.env.TELEGRAM_BOT_TOKEN, chatId: Number(process.env.TEST_TELEGRAM_CHAT_ID) }
    : undefined;

const NOTE =
  "Cosmetic labelling in India: customers read the front of the pack ('natural', 'dermatologist tested', '10% niacinamide') but the regulated part is mostly the back panel, the INCI list, batch number, manufacturer and expiry. None of the front claims tell you pH or whether the active is stable. Worth explaining which parts of a cosmetic label in India are actually regulated and which are marketing, and what a customer can check on the back.";

test('news-worthy note: draft arrives with news angle, source, date, link and verify flag', live, async (t) => {
  const r = await runNote(NOTE, { telegram });
  const final = r.sent.join('\n\n——— next message ———\n\n');
  t.diagnostic(`gate: ${JSON.stringify(r.gate)}`);
  t.diagnostic(`search_phrase: ${JSON.stringify(r.news.searchPhrase)}`);
  t.diagnostic(`article: ${JSON.stringify(r.news.article)}`);
  t.diagnostic(`used_news: ${r.news.usedNews} flag: ${r.news.flag}`);
  t.diagnostic(`telegram: ${telegram ? `real chat ${telegram.chatId}` : 'faked'}`);
  t.diagnostic(`FINAL MESSAGE:\n${final}`);

  assert.ok(r.gate?.score >= 6, `gate score ${r.gate?.score}`);
  assert.ok(r.news.searchPhrase, 'no search phrase');
  assert.ok(r.news.article, 'no article fetched');
  assert.equal(r.news.flag, 'appended', `draft did not use the news (used_news=${r.news.usedNews})`);

  const last = r.sent.at(-1);
  assert.ok(!final.includes('USED_NEWS'), 'marker leaked into the message');
  assert.match(last, /\n________________________________________\nNEWS SOURCE: .+\nFROM: .+ · \d{1,2} [A-Z][a-z]{2} \d{4}\nLINK: https:\/\/news\.google\.com\/\S+\n⚠ Check this before publishing — you are the author of this claim\n________________________________________$/);
  assert.ok(r.sent.every((m) => m.length <= 4096));

  // The news angle is in the post itself: the body attributes something to the publication.
  const publication = last.match(/\nFROM: (.+) · /)[1];
  const body = final.slice(0, final.lastIndexOf('\n________________________________________\nNEWS SOURCE:'));
  assert.ok(body.toLowerCase().includes(publication.toLowerCase()), `post body never mentions ${publication}`);
});
