// Checks the scoring prompt's judgement against the real Gemini API.
// Skipped unless GEMINI_API_KEY is set: npm run test:live (reads .env).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runNote } from './harness.js';

const live = { skip: !process.env.GEMINI_API_KEY && 'GEMINI_API_KEY not set' };

const STRONG =
  'family business shut in 2023. instead of waiting we took a Zostel franchise in Guwahati with zero hospitality experience. supply chains were frozen so we sourced bamboo from a village workshop and got carpenters ten minutes away. broke even faster than projected. guests never mention the furniture, they mention the people.';
const REMINDER = 'call zostel linen vendor about the invoice before thurs, also submit mesa assignment';
const ABANDONED = 'something about ops and how the';

function report(t, r) {
  t.diagnostic(`score=${r.gate?.score} decision=${r.gate?.decision} reason=${JSON.stringify(r.gate?.reason)}`);
}

test('strong note scores 6+ and is drafted', live, async (t) => {
  const r = await runNote(STRONG);
  report(t, r);
  assert.ok(r.gate, 'gate did not log a score');
  assert.ok(r.gate.score >= 6, `scored ${r.gate.score}`);
  // Scoring may retry once (e.g. after a 503); drafting must happen exactly once, after it.
  assert.equal(r.geminiCalls.filter((c) => c === 'draft').length, 1);
  assert.equal(r.geminiCalls.at(-1), 'draft');
  assert.equal(r.sent.length >= 1, true);
  assert.ok(!r.sent[0].startsWith('No draft made'), r.sent[0]);
  assert.ok(!r.sent[0].startsWith("Couldn't score"), r.sent[0]);
});

for (const [name, note] of [
  ['task reminder', REMINDER],
  ['abandoned thought', ABANDONED],
]) {
  test(`${name} scores 3 or below and is rejected without a draft`, live, async (t) => {
    const r = await runNote(note);
    report(t, r);
    assert.ok(r.gate, 'gate did not log a score');
    assert.ok(r.gate.score <= 3, `scored ${r.gate.score}`);
    assert.ok(!r.geminiCalls.includes('draft'), 'a draft call was made');
    assert.equal(r.sent.length, 1);
    assert.ok(r.sent[0].startsWith(`No draft made — scored ${r.gate.score}/10. `), r.sent[0]);
  });
}
