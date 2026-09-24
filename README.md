# Meera Writer

A Telegram bot that turns Meera's raw notes into LinkedIn drafts.

```
Meera → Telegram → Vercel (/api/telegram) → score gate (Gemini + scoring-prompt.txt) → news angle (Gemini keywords + Google News RSS, optional) → Gemini + voice-skill.txt → draft (+ verify flag if news was used) → same Telegram chat → Meera
```

## How it works

- `api/telegram.js` is the webhook. It checks Telegram's secret header, replies `200` straight away (so Telegram never resends and creates duplicate drafts), then finishes the work in the background using Vercel's `waitUntil`.
- `lib/gate.js` scores every note before drafting. It makes one Gemini call (JSON mode) with `scoring-prompt.txt`, which gets back a score from 0 to 10 and a one-line reason. Notes scoring below `DRAFT_SCORE_THRESHOLD` (6, in `lib/config.js`) are not drafted. Meera instead gets `No draft made — scored {score}/10. {reason}`. If scoring errors or returns something unparseable, it retries once. If that fails too, Meera gets "Couldn't score this note, so no draft was made. Send it again to retry." A note is never drafted without a score.
- `lib/news.js` adds an optional news angle to notes that pass the gate. It works in four steps:
  1. One Gemini call (JSON mode, `keywords-prompt.txt`) returns a search phrase.
  2. It fetches `news.google.com/rss/search?q=<phrase>+when:30d` (India edition) and takes the first item's headline, publication, date, link and snippet.
  3. It passes them to the drafting call, using `news-prompt.txt`, placed after the note.
  4. The model ends its draft with `USED_NEWS: yes/no`. The code strips that line. Unless the answer is a clear `no`, it appends a verify block built from the fetched fields, so the model can't change the headline or link.

  If any of these steps fails (keywords, fetch, timeout, no results), it's logged and the draft is written without news.
- `lib/gemini.js` builds the prompt and calls Gemini. **Every** request reads `voice-skill.txt` from disk and puts its full contents into Gemini's system instruction:
  ```
  SYSTEM/VOICE INSTRUCTIONS:
  <full voice-skill.txt>
  TASK RULES: (output only the post, don't invent facts, don't mention the bot/AI…)

  USER'S RAW NOTE:
  <Meera's message>
  Generate the LinkedIn post by applying the voice instructions to the raw note.
  ```
  The task rules only describe the job. All style decisions come from `voice-skill.txt`.
- `lib/telegram.js` sends messages. Replies go out as plain text and are split at paragraph breaks if a draft is over Telegram's 4096-character limit.
- `lib/voice.js` loads the voice file. `lib/config.js` reads environment variables.
- Telegram code and Gemini code don't import each other. Only the webhook connects them.

## Files

| Path | Purpose |
|---|---|
| `api/telegram.js` | Vercel function (the webhook endpoint) |
| `lib/gemini.js` | Gemini prompt and API call, response checks, retries |
| `lib/telegram.js` | Telegram Bot API calls and message splitting |
| `lib/voice.js` | Reads `voice-skill.txt` on every generation |
| `lib/config.js` | Environment variables and validation |
| `voice-skill.txt` | Meera's voice instructions (source of truth for style) |
| `scoring-prompt.txt` | The quality-gate prompt. Edit it to tune what gets drafted. `<<<NOTE>>>` is replaced with the note. |
| `lib/gate.js` | Scoring call, output validation, threshold decision |
| `keywords-prompt.txt` | Prompt that turns a note into a news search phrase |
| `news-prompt.txt` | Instructions and news item added to the drafting prompt (`{headline}`, `{publication}`, `{date}`, `{summary}` are filled in) |
| `lib/news.js` | Keyword call, Google News RSS fetch and parse, `USED_NEWS` handling, verify flag |
| `lib/prompts.js` | Loads the prompt `.txt` files |
| `test/` | `*.test.js` (Gemini and news faked) and `*.live.test.js` (real Gemini) |
| `scripts/set-webhook.mjs` | Connects the bot to your Vercel URL |
| `scripts/try-draft.mjs` | Generates one draft locally, without Telegram |
| `vercel.json` | Includes the prompt `.txt` files in the function bundle; sets a 180s time limit |
| `.env.example` | Template for environment variables |

## 1. Get credentials

1. **Telegram bot token:** message [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token. If you already have a bot, `/token` shows it and `/revoke` issues a new one.
2. **Gemini API key:** create one at <https://aistudio.google.com/apikey>.
3. **Webhook secret:** invent a random string. For example, run:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

## 2. Where the keys go

Keys never go in code. They go in two places:

- **Vercel** (used by the live bot): Project → Settings → Environment Variables.
- **`.env` in the project folder** (used only by the local scripts in steps 4 and 6). Create it from the template:
  ```bash
  cp .env.example .env
  ```
  `.env` is git-ignored.

| Variable | Required | Value |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | Token from BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | yes | The random string from step 1 |
| `GEMINI_API_KEY` | yes | Gemini key |
| `GEMINI_MODEL` | no | Defaults to `gemini-3.6-flash`. Use any model name from Google's model list. |
| `ALLOWED_TELEGRAM_USER_IDS` | recommended | Meera's Telegram user ID, so strangers can't spend your Gemini quota. Comma-separate multiple IDs. |
| `MAX_NOTE_CHARS` | no | Maximum note length. Defaults to 8000. |

## 3. Voice instructions

`voice-skill.txt` sits in the project root. To change how Meera writes, edit that file and redeploy. No code changes are needed. The file is read fresh on every generation, and `vercel.json` makes sure it ships with the function.

## 4. Test locally (optional)

Run the tests:

```bash
npm test
```

This runs the gate's unit tests (threshold boundary, parsing, fail-closed path) with Gemini faked. The live tests are skipped.

```bash
npm run test:live
```

This also runs real notes through real Gemini and Google News: three through the gate, and one end to end with news. It reads `GEMINI_API_KEY` from `.env` and uses about 7 Gemini requests. If `.env` also has `TELEGRAM_BOT_TOKEN` and `TEST_TELEGRAM_CHAT_ID` (your own user ID), the end-to-end draft is really sent to that chat.

To try a single draft:

Requires Node 20 or newer.

```bash
npm install
npm run draft -- "Customers keep asking whether our serum is 'clean'. The term isn't regulated in India."
```

This prints the draft Gemini writes, using your `.env` and `voice-skill.txt`.

## 5. Deploy to Vercel

**Option A: GitHub (recommended)**
1. Push this folder to a GitHub repository.
2. In Vercel, click **Add New → Project** and import the repo. Leave Framework Preset as **Other**, and leave the build and output settings empty.
3. Before the first deploy, add the environment variables from step 2.
4. Deploy. Note the production URL, e.g. `https://meera-writer.vercel.app`.

**Option B: Vercel CLI**
```bash
npm i -g vercel
vercel
```

```bash
vercel env add TELEGRAM_BOT_TOKEN
```
Repeat `vercel env add` for each variable, then deploy to production:

```bash
vercel --prod
```

Check that it's running: opening `https://<your-url>/api/telegram` in a browser should show `{"ok":true,"service":"meera-writer"}`.

If you change environment variables later, redeploy so they take effect.

## 6. Connect the Telegram webhook

With `.env` filled in:

```bash
npm run set-webhook -- https://<your-url>
```

This registers `https://<your-url>/api/telegram` with the secret token. You can also do it without the script:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" -d "url=https://<your-url>/api/telegram" -d "secret_token=<SECRET>" -d "allowed_updates=[\"message\"]"
```

Use your production URL (or a custom domain). Preview-deployment URLs change with every deploy and may be behind Vercel's deployment protection.

## 7. Lock the bot to Meera

1. Meera opens the bot and sends `/id`. The bot replies with her user ID.
2. Put that number in `ALLOWED_TELEGRAM_USER_IDS` on Vercel and redeploy.

After that, anyone else gets "Sorry, this bot is private."

## Using it

Meera sends a text note and gets a draft back in the same chat, as a reply to her note. She can send another note whenever she wants. `/start` and `/help` explain this.

## Error handling

| Situation | What happens |
|---|---|
| Request without the right secret header | `401`, ignored |
| Malformed body / not a Telegram update | `400` |
| Missing Telegram env vars | `500`, logged (the bot can't reply without a token) |
| Missing Gemini key or model problem | Meera is told the bot owner needs to check settings |
| `voice-skill.txt` missing or empty | No draft is written; Meera is told the instructions couldn't be loaded |
| Empty message, sticker, photo without caption | Asks for a text note |
| Note over `MAX_NOTE_CHARS` | Asks her to shorten it |
| Gemini timeout, 429, 5xx, empty or unexpected response, cut-off draft | Retries once, then sends a short "please try again" message |
| Safety block | Asks her to rephrase |
| Draft longer than 4096 characters | Split into several messages at paragraph breaks |
| Note scores below 6 | No draft. Meera gets the score and the reason. |
| Scoring call fails or returns bad output twice | No draft. Meera is asked to send it again. |
| Keyword call fails, Google News times out (10s), errors or has no results | Logged. The draft is written without news and has no flag. |
| Draft used the news, or didn't say clearly whether it did | Verify block appended, and kept whole in the last message if the draft is split |
| Edited messages, group events, etc. | Ignored |

Errors are logged in Vercel → Project → Logs. The Gemini key and Telegram token are never logged.

## Troubleshooting

- **Bot doesn't reply:** run `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo` and read `last_error_message`. A `401` there means the secret on Vercel doesn't match the one used in `setWebhook`. Fix it and run step 6 again.
- **"rejected the request" message:** the Gemini key is invalid or `GEMINI_MODEL` names a model that doesn't exist. Check Vercel logs for the exact error.
- **Timeouts:** switch `GEMINI_MODEL` to a faster model. The function limit is 180s (in `vercel.json`).
- **"Couldn't score this note" or "busy" messages, with 429 in the logs:** Gemini's free tier allows about 20 requests per day per model. Each note uses 3 (scoring, news keywords, drafting), plus any retries. Turn on billing for the Gemini project in AI Studio to remove the daily limit.
- **Tuning the gate:** edit `scoring-prompt.txt` and redeploy. To change the pass mark, edit `DRAFT_SCORE_THRESHOLD` in `lib/config.js`.
