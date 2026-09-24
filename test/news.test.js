// News-angle step with Gemini and Google News faked (except the no-results test,
// which queries the real feed with a nonsense phrase).

import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.GEMINI_API_KEY ||= 'TEST_KEY';

const { finaliseDraft, formatNewsDate, parseFirstItem, verifyFlag } = await import('../lib/news.js');
const { buildChunks } = await import('../lib/telegram.js');
const { geminiText, rssResponse, runNote } = await import('./harness.js');

const NOTE = 'a note that passes the gate; Gemini is faked';
const SCORE = '{"score": 8, "reason": "Specific."}';
const POST = 'First paragraph of the post.\n\nSecond paragraph, citing The Economic Times.';

// Shape copied from a real Google News RSS item (description is double-encoded HTML).
const URL_ =
  'https://news.google.com/rss/articles/CBMikwJBVV95cUxQVWZEVXNMUm5tbDRFTTJPeW5MRk_test-id?oc=5';
const ITEM = `<item><title>Sunscreen grows from niche to staple on India’s beauty shelf - The Economic Times</title><link>${URL_}</link><guid isPermaLink="false">x</guid><pubDate>Tue, 22 Sep 2026 20:30:00 GMT</pubDate><description>&lt;a href="${URL_}" target="_blank"&gt;Sunscreen grows from niche to staple on India’s beauty shelf&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;The Economic Times&lt;/font&gt;</description><source url="https://economictimes.indiatimes.com">The Economic Times</source></item>`;

const EXPECTED_ITEM = {
  headline: 'Sunscreen grows from niche to staple on India’s beauty shelf',
  publication: 'The Economic Times',
  date: '23 Sep 2026', // 20:30 GMT on the 22nd is 02:00 IST on the 23rd
  url: URL_,
  summary: 'Sunscreen grows from niche to staple on India’s beauty shelf',
};

function fakeGemini(draftText) {
  return (kind) =>
    geminiText(
      kind === 'score'
        ? SCORE
        : kind === 'keywords'
          ? '{"keywords": ["sunscreen", "India"], "search_phrase": "sunscreen India"}'
          : draftText,
    );
}

// ---- parsing ----

test('parseFirstItem reads a Google News item', () => {
  assert.deepEqual(parseFirstItem(`<rss><channel>${ITEM}${ITEM}</channel></rss>`), EXPECTED_ITEM);
});

test('parseFirstItem returns null for a feed with no items', () => {
  assert.equal(parseFirstItem('<rss><channel><title>x</title></channel></rss>'), null);
});

test('formatNewsDate formats as "24 Sep 2026"', () => {
  assert.equal(formatNewsDate('Thu, 24 Sep 2026 06:00:00 GMT'), '24 Sep 2026');
  assert.equal(formatNewsDate('not a date'), '');
});

// ---- USED_NEWS → flag ----

test('USED_NEWS: yes → line stripped, flag built from the fetched item', () => {
  const r = finaliseDraft(`${POST}\n\nUSED_NEWS: yes`, EXPECTED_ITEM);
  assert.equal(r.post, POST);
  assert.equal(r.usedNews, 'yes');
  assert.equal(
    r.flag,
    [
      '________________________________________',
      'NEWS SOURCE: Sunscreen grows from niche to staple on India’s beauty shelf',
      'FROM: The Economic Times · 23 Sep 2026',
      `LINK: ${URL_}`,
      '⚠ Check this before publishing — you are the author of this claim',
      '________________________________________',
    ].join('\n'),
  );
});

test('marker variants are recognised and stripped', () => {
  for (const line of ['**USED_NEWS: no**', 'used_news: No.', '  USED_NEWS:no  ']) {
    const r = finaliseDraft(`${POST}\n${line}`, EXPECTED_ITEM);
    assert.equal(r.post, POST, line);
    assert.equal(r.flag, null, line);
  }
});

test('missing or contradictory marker with a news item → flag appended anyway', () => {
  assert.equal(finaliseDraft(POST, EXPECTED_ITEM).usedNews, 'unclear');
  assert.ok(finaliseDraft(POST, EXPECTED_ITEM).flag);
  const both = finaliseDraft(`${POST}\nUSED_NEWS: no\nUSED_NEWS: yes`, EXPECTED_ITEM);
  assert.equal(both.usedNews, 'unclear');
  assert.ok(both.flag);
  assert.ok(finaliseDraft(`${POST}\nUSED_NEWS: maybe`, EXPECTED_ITEM).flag);
});

test('no news item → no flag, even if the model writes a marker', () => {
  const r = finaliseDraft(`${POST}\nUSED_NEWS: yes`, null);
  assert.equal(r.flag, null);
  assert.equal(r.post, POST);
});

// ---- splitting ----

test('long draft is split but the flag stays whole in the last message', () => {
  const flag = verifyFlag(EXPECTED_ITEM);
  const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${'word '.repeat(40)}`).join('\n\n');
  const chunks = buildChunks(long, flag);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 4096));
  assert.ok(chunks.at(-1).endsWith(flag));
  assert.equal(chunks.filter((c) => c.includes('NEWS SOURCE:')).length, 1);
});

test('flag goes in its own message when the last chunk has no room for it', () => {
  const flag = verifyFlag(EXPECTED_ITEM);
  const chunks = buildChunks('x'.repeat(4000), flag);
  assert.deepEqual(chunks, ['x'.repeat(4000), flag]);
});

// ---- pipeline (handleUpdate) ----

test('news used: prompt gets the item, sent message has post + flag, no marker', async () => {
  const r = await runNote(NOTE, {
    gemini: fakeGemini(`${POST}\n\nUSED_NEWS: yes`),
    news: () => rssResponse(ITEM),
  });
  assert.deepEqual(r.geminiCalls, ['score', 'keywords', 'draft']);
  assert.match(r.newsUrls[0], /q=sunscreen%20India\+when:30d&hl=en-IN&gl=IN&ceid=IN:en$/);
  assert.match(r.draftPrompt, /NEWS ITEM\nHeadline: Sunscreen grows from niche to staple on India’s beauty shelf\nPublication: The Economic Times\nDate: 23 Sep 2026\nSnippet: /);
  assert.match(r.draftPrompt, /USED_NEWS: yes or USED_NEWS: no/);
  assert.deepEqual(r.sent, [`${POST}\n\n${verifyFlag(EXPECTED_ITEM)}`]);
  assert.equal(r.news.usedNews, 'yes');
});

test('missing USED_NEWS line with a news item → flag still appended', async () => {
  const r = await runNote(NOTE, { gemini: fakeGemini(POST), news: () => rssResponse(ITEM) });
  assert.deepEqual(r.sent, [`${POST}\n\n${verifyFlag(EXPECTED_ITEM)}`]);
  assert.equal(r.news.usedNews, 'unclear');
});

test('USED_NEWS: no → no flag, and the marker is not in the sent message', async () => {
  const r = await runNote(NOTE, {
    gemini: fakeGemini(`${POST}\n\nUSED_NEWS: no`),
    news: () => rssResponse(ITEM),
  });
  assert.deepEqual(r.sent, [POST]);
  assert.ok(!r.sent.join('\n').includes('USED_NEWS'));
});

test('no results (real Google News, nonsense phrase) → draft arrives with no flag', async () => {
  const r = await runNote(NOTE, {
    gemini: (kind) =>
      geminiText(
        kind === 'score'
          ? SCORE
          : kind === 'keywords'
            ? '{"keywords": ["zqxjv"], "search_phrase": "zqxjv plomtrek vorbulant"}'
            : POST,
      ),
  });
  assert.equal(r.news.article, null);
  assert.ok(r.logs.some((l) => l.includes('cause=no_results')), 'expected a no_results log line');
  assert.ok(!r.draftPrompt.includes('NEWS ITEM'));
  assert.deepEqual(r.sent, [POST]);
});

test('fetch timeout (real 10s AbortSignal) → draft arrives with no flag', async () => {
  const r = await runNote(NOTE, {
    gemini: fakeGemini(POST),
    // Never responds; only the request's own timeout signal can end it.
    news: (url, opts) =>
      new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason))),
  });
  assert.ok(r.logs.some((l) => l.includes('cause=fetch_timeout')), 'expected a fetch_timeout log line');
  assert.ok(!r.draftPrompt.includes('NEWS ITEM'));
  assert.deepEqual(r.sent, [POST]);
});

test('HTTP error from Google News → draft arrives with no flag', async () => {
  const r = await runNote(NOTE, { gemini: fakeGemini(POST), news: () => new Response('no', { status: 503 }) });
  assert.ok(r.logs.some((l) => l.includes('cause=fetch_failed')));
  assert.deepEqual(r.sent, [POST]);
});

test('keyword extraction failure → no fetch, draft arrives with no flag', async () => {
  const r = await runNote(NOTE, {
    gemini: (kind) => (kind === 'keywords' ? new Response('boom', { status: 500 }) : geminiText(kind === 'score' ? SCORE : POST)),
    news: () => assert.fail('news should not be fetched'),
  });
  assert.deepEqual(r.newsUrls, []);
  assert.deepEqual(r.sent, [POST]);
});
