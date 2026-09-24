// Gate logic with Gemini faked: threshold boundary, parsing, and the fail-closed path.

import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.GEMINI_API_KEY ||= 'TEST_KEY';

const { DRAFT_SCORE_THRESHOLD } = await import('../lib/config.js');
const { SCORE_FAILED_MESSAGE, parseScore } = await import('../lib/gate.js');
const { geminiText, rssResponse, runNote: runWithFakes } = await import('./harness.js');

const NOTE = 'any note; the score is faked';
const DRAFT = 'A drafted LinkedIn post.';
const KEYWORDS = '{"keywords": ["x"], "search_phrase": "x"}';

// Gate tests stay offline: the news feed is faked and returns no items.
const runNote = (note, opts) => runWithFakes(note, { news: () => rssResponse(''), ...opts });

function fakeGemini(scoreJson) {
  return (kind) => geminiText(kind === 'score' ? scoreJson : kind === 'keywords' ? KEYWORDS : DRAFT);
}

test('threshold is 6', () => {
  assert.equal(DRAFT_SCORE_THRESHOLD, 6);
});

test('score 5 is rejected with the reason, and no draft call is made', async () => {
  const r = await runNote(NOTE, { gemini: fakeGemini('{"score": 5, "reason": "Vague topic, no angle."}') });
  assert.deepEqual(r.geminiCalls, ['score']);
  assert.deepEqual(r.sent, ['No draft made — scored 5/10. Vague topic, no angle.']);
  assert.equal(r.gate.decision, 'rejected');
});

for (const score of [6, 7]) {
  test(`score ${score} passes the gate and is drafted`, async () => {
    const r = await runNote(NOTE, { gemini: fakeGemini(`{"score": ${score}, "reason": "Clear angle."}`) });
    assert.deepEqual(r.geminiCalls, ['score', 'keywords', 'draft']);
    assert.deepEqual(r.sent, [DRAFT]);
    assert.equal(r.gate.decision, 'drafted');
  });
}

test('unparseable score output: one retry, then the error message, no draft', async () => {
  const r = await runNote(NOTE, {
    gemini: (kind) => geminiText(kind === 'score' ? 'Sure! I would give this a 7.' : DRAFT),
  });
  assert.deepEqual(r.geminiCalls, ['score', 'score']);
  assert.deepEqual(r.sent, [SCORE_FAILED_MESSAGE]);
});

test('scoring API error: one retry, then the error message, no draft', async () => {
  const r = await runNote(NOTE, {
    gemini: (kind) => (kind === 'score' ? new Response('boom', { status: 500 }) : geminiText(DRAFT)),
  });
  assert.deepEqual(r.geminiCalls, ['score', 'score']);
  assert.deepEqual(r.sent, [SCORE_FAILED_MESSAGE]);
});

test('a failed first attempt followed by a valid score continues normally', async () => {
  let scoreCalls = 0;
  const r = await runNote(NOTE, {
    gemini: (kind) =>
      kind === 'score'
        ? geminiText(++scoreCalls === 1 ? 'not json' : '{"score": 8, "reason": "Specific data."}')
        : geminiText(kind === 'keywords' ? KEYWORDS : DRAFT),
  });
  assert.deepEqual(r.geminiCalls, ['score', 'score', 'keywords', 'draft']);
  assert.deepEqual(r.sent, [DRAFT]);
});

test('parseScore accepts fenced JSON and rejects invalid scores', () => {
  assert.deepEqual(parseScore('```json\n{"score": 4, "reason": "Topic only."}\n```'), {
    score: 4,
    reason: 'Topic only.',
  });
  for (const bad of [
    '{"score": 11, "reason": "x"}',
    '{"score": -1, "reason": "x"}',
    '{"score": 6.5, "reason": "x"}',
    '{"score": "7", "reason": "x"}',
    '{"score": 7}',
    '{"score": 7, "reason": "  "}',
    'null',
    'seven',
  ]) {
    assert.throws(() => parseScore(bad), undefined, bad);
  }
});
