# BPSC NEXUS — GitHub-ready final upgrade

This package is designed for the EXISTING repository structure:

- `index.html` — replace this file
- `server.mjs` — replace this file
- `package.json` — replace this file
- `render.yaml` — replace this file
- `records-1.js` through `records-8.js` — **DO NOT replace; keep your existing files exactly as they are**

## What is integrated

### Custom Mock
Uses the existing `RECORDS` array assembled by your current `records-1.js` ... `records-8.js` architecture.

Features:
- subject selection
- optional topic filter
- question count
- Exam / Practice mode
- All Vault / PYQ / Current Affairs source
- Random
- Balanced across selected subjects
- Weak / Mistake questions
- Unattempted
- Revision Bank
- Bookmarks
- optional difficulty filter where explicit metadata exists
- optional timer
- uses the existing `startQuizItems()` quiz engine
- custom mock result statistics

### Question Translator
The existing `/api/translate` endpoint is used.
- question + all options are translated as a single controlled batch
- original English question remains untouched
- translations are cached in the browser for the session
- translation is source-faithful and does not reveal the answer

The existing global EN/हिंदी translator remains intact.

### NIVA 2.0
Adds:
- Tutor
- Doubt Solver
- Quiz Master
- Revision Coach
- Strategy
- current-question quick actions
- stronger exam-oriented prompting
- source-vs-NIVA reasoning distinction

The existing `/api/niva` endpoint remains the secure Gemini proxy.

### Analytics
The frontend emits anonymous product events such as:
- vault_loaded
- custom_mock_open
- custom_mock_start
- quiz_start
- question_answer
- quiz_finish
- question_translation

No question text, NIVA conversation, API key, or direct personal information is sent as an analytics event.

For persistent cross-user analytics, set `POSTHOG_API_KEY` on Render. The included `render.yaml` declares it as a secret environment variable. If it is blank, analytics calls safely do nothing server-side.

## Render

Your current service already runs `npm start`, and the server serves `index.html` plus the records files. Keep that architecture.

Required:
- `GEMINI_API_KEY`

Optional:
- `GEMINI_MODEL`
- `POSTHOG_API_KEY`
- `POSTHOG_HOST`

After uploading these four replacement files to GitHub, Render should redeploy automatically.

## Important

Do NOT upload a second copy of the records files from this package. Your existing eight record files are the source of the question database and are intentionally left untouched.


## Premium Product Upgrade

This build is packaged as a ₹149 launch-ready BPSC practice product. It adds a Premium Command Center with Smart Practice, BPSC Full-Length Mock (150 questions / 120 minutes / +1 and -1/3 scoring), Daily Challenge, Search Vault, PYQ Hub, Revision Bank, Mistake Notebook, Bookmarks, subject performance, weak-topic analysis, activity tracking and progress export.

The source question files remain unchanged. The application reports the full 30,157-record vault while Smart Practice and premium tests use only records with machine-verifiable answer data and at least four options (29,234 records in this build). This prevents incomplete source records from being silently served in paid tests.
