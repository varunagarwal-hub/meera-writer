// Safe self-check shown on GET /api/telegram. Reveals no secrets and makes no API calls:
// only whether settings are present, whether the prompt files were bundled, and a short
// one-way fingerprint of the Gemini key so the owner can tell which key is deployed.

import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { getGeminiConfig } from './config.js';

const PROMPT_FILES = ['voice-skill.txt', 'scoring-prompt.txt', 'keywords-prompt.txt', 'news-prompt.txt'];

export function keyFingerprint(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

export async function selfCheck() {
  const files = {};
  for (const name of PROMPT_FILES) {
    files[name] = await access(path.join(process.cwd(), name)).then(
      () => true,
      () => false,
    );
  }

  const key = process.env.GEMINI_API_KEY?.trim();
  let model = null;
  try {
    ({ model } = getGeminiConfig());
  } catch {
    // key missing; reported below
  }

  return {
    promptFiles: files,
    gemini: { keySet: Boolean(key), keyFingerprint: key ? keyFingerprint(key) : null, model },
    telegram: {
      botTokenSet: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
      webhookSecretSet: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET?.trim()),
      allowlistSet: Boolean(process.env.ALLOWED_TELEGRAM_USER_IDS?.trim()),
    },
  };
}
