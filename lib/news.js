// News angle: finds one recent news item for an approved note, and after drafting,
// turns the model's USED_NEWS marker into a code-built verify flag.
// Optional by design: every failure here means "no news item", never "no draft".

import { extractText, requestGemini } from './gemini.js';
import { fillTemplate, loadPromptFile } from './prompts.js';

const NOTE_PLACEHOLDER = '<<<NOTE>>>';
const KEYWORDS_TIMEOUT_MS = 20_000;
const NEWS_TIMEOUT_MS = 10_000;
const MAX_SUMMARY_CHARS = 280;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const FLAG_RULE = '________________________________________';

// ---- 1. Keyword extraction (Gemini) ----

export async function extractKeywords(note, { request = requestGemini } = {}) {
  const template = await loadPromptFile('keywords-prompt.txt', { requires: [NOTE_PLACEHOLDER] });
  const body = {
    contents: [{ role: 'user', parts: [{ text: template.split(NOTE_PLACEHOLDER).join(note) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          keywords: { type: 'ARRAY', items: { type: 'STRING' } },
          search_phrase: { type: 'STRING' },
        },
        required: ['keywords', 'search_phrase'],
      },
      maxOutputTokens: 4096,
    },
  };
  const data = await request(body, { timeoutMs: KEYWORDS_TIMEOUT_MS });
  return parseKeywords(extractText(data));
}

export function parseKeywords(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned);
  const phrase = typeof parsed?.search_phrase === 'string' ? parsed.search_phrase.trim() : '';
  if (!phrase) throw new Error('Keyword output has no search_phrase');
  const keywords = Array.isArray(parsed.keywords)
    ? parsed.keywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim())
    : [];
  return { keywords, searchPhrase: phrase };
}

// ---- 2. Fetch news (Google News RSS) ----

export function newsSearchUrl(searchPhrase) {
  return (
    `https://news.google.com/rss/search?q=${encodeURIComponent(searchPhrase)}+when:30d` +
    '&hl=en-IN&gl=IN&ceid=IN:en'
  );
}

// Returns the first item, or null when the feed has no usable items. Throws on HTTP/network errors.
export async function fetchNews(searchPhrase) {
  const res = await fetch(newsSearchUrl(searchPhrase), {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(NEWS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Google News returned HTTP ${res.status}`);
  return parseFirstItem(await res.text());
}

// Minimal RSS reader for Google News' feed format: only the first <item> is needed,
// so a dependency-free parser is enough.
export function parseFirstItem(xml) {
  const item = xml.match(/<item\b[^>]*>([\s\S]*?)<\/item>/i)?.[1];
  if (!item) return null;

  const title = readTag(item, 'title');
  const url = readTag(item, 'link');
  if (!title || !url) return null;

  const publication = readTag(item, 'source') || title.match(/ - ([^-]+)$/)?.[1]?.trim() || 'Unknown publication';
  const headline = stripPublicationSuffix(title, publication);
  const pubDate = readTag(item, 'pubDate');
  // Google News descriptions are "<a>Headline</a>&nbsp;&nbsp;<font>Publication</font>".
  let summary = oneLine(stripHtml(readTag(item, 'description')));
  if (summary.endsWith(` ${publication}`)) summary = summary.slice(0, -publication.length).trim();
  summary = summary.slice(0, MAX_SUMMARY_CHARS);

  return {
    headline,
    publication,
    date: formatNewsDate(pubDate) || pubDate || 'Date unknown',
    url,
    summary: summary || headline,
  };
}

function readTag(xml, tag) {
  const raw = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))?.[1];
  if (raw === undefined) return '';
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return (cdata ? cdata[1] : decodeEntities(raw)).trim();
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripHtml(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '));
}

function oneLine(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function stripPublicationSuffix(title, publication) {
  const suffix = ` - ${publication}`;
  if (title.endsWith(suffix)) return title.slice(0, -suffix.length).trim();
  return title.replace(/ - [^-]+$/, '').trim() || title;
}

// "Wed, 24 Sep 2026 03:00:00 GMT" → "24 Sep 2026" (in India time, where the reader is).
export function formatNewsDate(pubDate) {
  const ms = Date.parse(pubDate);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms + IST_OFFSET_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// ---- Orchestration: never throws ----

// Returns { item, prompt } (prompt = filled news-prompt.txt for the drafting call), or null.
// Logs the search phrase and the article (or "none").
export async function findNews(note, { noteId = JSON.stringify(note.slice(0, 50)) } = {}) {
  let searchPhrase;
  try {
    ({ searchPhrase } = await extractKeywords(note));
  } catch (err) {
    console.warn(`[news] note=${noteId} search_phrase=none article=none cause=keywords_failed error=${JSON.stringify(err.message)}`);
    return null;
  }

  let item;
  try {
    item = await fetchNews(searchPhrase);
  } catch (err) {
    const cause = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'fetch_timeout' : 'fetch_failed';
    console.warn(`[news] note=${noteId} search_phrase=${JSON.stringify(searchPhrase)} article=none cause=${cause} error=${JSON.stringify(err.message)}`);
    return null;
  }

  if (!item) {
    console.log(`[news] note=${noteId} search_phrase=${JSON.stringify(searchPhrase)} article=none cause=no_results`);
    return null;
  }
  let prompt;
  try {
    prompt = await buildNewsPrompt(item);
  } catch (err) {
    console.warn(`[news] note=${noteId} search_phrase=${JSON.stringify(searchPhrase)} article=none cause=prompt_failed error=${JSON.stringify(err.message)}`);
    return null;
  }

  console.log(
    `[news] note=${noteId} search_phrase=${JSON.stringify(searchPhrase)} article=${JSON.stringify(`${item.headline} — ${item.publication}, ${item.date}`)} url=${item.url}`,
  );
  return { item, prompt };
}

// ---- 3. Prompt addition for the drafting call ----

export async function buildNewsPrompt(item) {
  const template = await loadPromptFile('news-prompt.txt');
  return fillTemplate(template, {
    '{headline}': item.headline,
    '{publication}': item.publication,
    '{date}': item.date,
    '{summary}': item.summary,
  });
}

// ---- 4. USED_NEWS marker → verify flag ----

const USED_NEWS_LINE = /^[\s*_`>]*USED_NEWS\s*:\s*(.*?)[\s*_`.]*$/i;

// Strips every USED_NEWS line from the draft. Returns { post, usedNews, flag }:
//   usedNews  'yes' | 'no' | 'unclear' | 'n/a' (no item supplied)
//   flag      the verify block to send after the post, or null
// The flag is built from the fetched item, so the model can't alter the headline or URL.
// If an item was supplied, only an unambiguous "no" drops the flag.
export function finaliseDraft(draft, item) {
  const answers = [];
  const kept = draft.split('\n').filter((line) => {
    const m = line.match(USED_NEWS_LINE);
    if (m) answers.push(m[1].trim().toLowerCase());
    return !m;
  });
  const post = kept.join('\n').trim();

  if (!item) return { post, usedNews: 'n/a', flag: null };

  const distinct = [...new Set(answers)];
  const usedNews = distinct.length === 1 && (distinct[0] === 'yes' || distinct[0] === 'no') ? distinct[0] : 'unclear';
  return { post, usedNews, flag: usedNews === 'no' ? null : verifyFlag(item) };
}

export function verifyFlag(item) {
  return [
    FLAG_RULE,
    `NEWS SOURCE: ${item.headline}`,
    `FROM: ${item.publication} · ${item.date}`,
    `LINK: ${item.url}`,
    '⚠ Check this before publishing — you are the author of this claim',
    FLAG_RULE,
  ].join('\n');
}
