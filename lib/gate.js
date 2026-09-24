// Quality gate: scores a raw note with Gemini before drafting and stops weak notes.
// Fails closed: if the note can't be scored, it is not drafted.

import { DRAFT_SCORE_THRESHOLD } from './config.js';
import { extractText, requestGemini } from './gemini.js';
import { loadPromptFile } from './prompts.js';

export class ScoringError extends Error {}

export const SCORE_FAILED_MESSAGE =
  "Couldn't score this note, so no draft was made. Send it again to retry.";

const NOTE_PLACEHOLDER = '<<<NOTE>>>';
const MAX_ATTEMPTS = 2; // first try + one retry
const SCORING_TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 2_000; // brief pause so a momentary 503/429 has a chance to clear

export function loadScoringPrompt() {
  return loadPromptFile('scoring-prompt.txt', { requires: [NOTE_PLACEHOLDER] });
}

// Returns { score, reason }. Throws ScoringError after MAX_ATTEMPTS failed calls or unparseable outputs.
// `request` is injectable so tests can force a bad response.
export async function scoreNote(note, { request = requestGemini } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const template = await loadScoringPrompt();
      const body = {
        contents: [{ role: 'user', parts: [{ text: template.split(NOTE_PLACEHOLDER).join(note) }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: { score: { type: 'INTEGER' }, reason: { type: 'STRING' } },
            required: ['score', 'reason'],
          },
          maxOutputTokens: 4096,
        },
      };
      const data = await request(body, { timeoutMs: SCORING_TIMEOUT_MS });
      return parseScore(extractText(data));
    } catch (err) {
      lastError = err;
      console.warn(`[score] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  throw new ScoringError(`Scoring failed after ${MAX_ATTEMPTS} attempts: ${lastError.message}`);
}

export function parseScore(text) {
  const cleaned = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new ScoringError(`Score output is not JSON: ${cleaned.slice(0, 200)}`);
  }
  const { score, reason } = parsed ?? {};
  if (!Number.isInteger(score) || score < 0 || score > 10) {
    throw new ScoringError(`Score is not an integer 0–10: ${JSON.stringify(score)}`);
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new ScoringError('Score output has no reason');
  }
  return { score, reason: reason.trim() };
}

export function rejectionMessage({ score, reason }) {
  return `No draft made — scored ${score}/10. ${reason}`;
}

// Decides whether a note may be drafted. Never throws.
// Returns { pass: true, score, reason } or { pass: false, message, score?, reason? }.
export async function checkNote(note, { noteId, score = scoreNote } = {}) {
  const label = noteId ?? JSON.stringify(note.slice(0, 50));
  let result;
  try {
    result = await score(note);
  } catch (err) {
    console.error(`[gate] note=${label} score=none decision=rejected cause=scoring_failed error=${JSON.stringify(err.message)}`);
    return { pass: false, message: SCORE_FAILED_MESSAGE };
  }

  const pass = result.score >= DRAFT_SCORE_THRESHOLD;
  console.log(
    `[gate] note=${label} score=${result.score} reason=${JSON.stringify(result.reason)} decision=${pass ? 'drafted' : 'rejected'}`,
  );
  return pass ? { pass, ...result } : { pass, ...result, message: rejectionMessage(result) };
}
