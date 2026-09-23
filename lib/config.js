// Reads and validates environment variables. Nothing secret is hardcoded here.

export class ConfigError extends Error {}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new ConfigError(`Missing required environment variable: ${name}`);
  return value;
}

function optional(name, fallback) {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

export function getTelegramConfig() {
  return {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    webhookSecret: required('TELEGRAM_WEBHOOK_SECRET'),
    allowedUserIds: optional('ALLOWED_TELEGRAM_USER_IDS', '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  };
}

export function getGeminiConfig() {
  return {
    apiKey: required('GEMINI_API_KEY'),
    model: optional('GEMINI_MODEL', 'gemini-2.5-flash'),
  };
}

export function getMaxNoteChars() {
  const n = Number.parseInt(optional('MAX_NOTE_CHARS', '8000'), 10);
  return Number.isFinite(n) && n > 0 ? n : 8000;
}
