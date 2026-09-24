// Generates one draft locally, without Telegram, to test Gemini and voice-skill.txt.
// Usage: npm run draft -- "your raw note here"

import { generateLinkedInPost } from '../lib/gemini.js';

const note = process.argv.slice(2).join(' ').trim();
if (!note) {
  console.error('Usage: npm run draft -- "your raw note here"');
  process.exit(1);
}

try {
  console.log(await generateLinkedInPost(note));
} catch (err) {
  console.error(err.userMessage ? `${err.message}\n(the Telegram user would see: ${err.userMessage})` : err.message);
  process.exit(1);
}
