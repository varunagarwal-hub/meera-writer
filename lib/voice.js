// Loads voice-skill.txt from disk. Called on every generation so edits to the
// file take effect on the next deploy with no code changes, and nothing is cached.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export class VoiceFileError extends Error {}

const VOICE_FILE = path.join(process.cwd(), 'voice-skill.txt');

export async function loadVoiceInstructions() {
  let text;
  try {
    text = await readFile(VOICE_FILE, 'utf8');
  } catch (err) {
    throw new VoiceFileError(`Could not read ${VOICE_FILE}: ${err.message}`);
  }
  // Strip a UTF-8 BOM if the file was saved by a Windows editor.
  text = text.replace(/^﻿/, '').trim();
  if (!text) throw new VoiceFileError('voice-skill.txt is empty');
  return text;
}
