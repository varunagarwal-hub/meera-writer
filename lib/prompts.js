// Loads prompt templates stored as .txt files in the project root. Read on every call,
// so prompts can be tuned by editing the file and redeploying, with no code changes.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export class PromptFileError extends Error {}

export async function loadPromptFile(fileName, { requires = [] } = {}) {
  const file = path.join(process.cwd(), fileName);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new PromptFileError(`Could not read ${file}: ${err.message}`);
  }
  text = text.replace(/^﻿/, '').trim();
  for (const placeholder of requires) {
    if (!text.includes(placeholder)) {
      throw new PromptFileError(`${fileName} must contain ${placeholder}`);
    }
  }
  return text;
}

// Replaces each {key} with values[key]. Uses split/join so "$" in values is taken literally.
export function fillTemplate(template, values) {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(key).join(value);
  }
  return out;
}
