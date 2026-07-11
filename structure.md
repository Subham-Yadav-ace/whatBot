# AIT Placement Bot — Full Project Plan

Status: Planning document (no code yet — build from this later)
Scope: Final refined version — one-way WhatsApp GROUP BROADCASTER (not a conversational bot)

---

## 1. Final Decided Scope

This is the FINAL, simplified scope (superseding earlier drafts that had per-user
registration, eligibility matching, and conversational search):

- The bot has **no replies, no commands, no conversations**.
- Its only job: **monitor the placement portal and broadcast updates to a single
  WhatsApp group** that already contains only eligible students (e.g. your batch/branch group).
- Group is configured **"Only Admins Can Send Messages"** — students can read,
  download PDFs, open links, but cannot send messages or spam the bot.
- No individual registration, no per-student CGPA/branch database, no eligibility engine.
  Group membership itself is the eligibility filter.

This cuts out the riskiest/most complex parts of the earlier drafts (webhook handling,
conversational NL→query parsing, per-user reminder preferences) and makes this
actually finishable as a portfolio project.

---

## 2. Confirmed Tech Stack Decisions

| Concern | Decision | Why |
|---|---|---|
| Deployment | **AWS (ECS/Docker)** | Matches your existing MindMap deployment; NOT Oracle Cloud (an earlier draft mentioned Oracle — ignore that) |
| AI Summarization | **Gemini API** (`@anthropic-ai/sdk`) | Structured JSON extraction from raw notice text |
| Scheduler | **BullMQ (Redis-based)**, not node-cron | You already know BullMQ deeply from MindMap (delayed jobs, retries, repeatable jobs) — reuse that knowledge; gives free retry/observability and clean delayed-job support for deadline reminders |
| WhatsApp | **whatsapp-web.js** (unofficial, puppeteer-based), broadcasting to ONE group | Matches final plan.md decision; free, no Meta Business verification needed; acceptable risk for a broadcast-only bot in a small group |
| Portal Auth | **Playwright, manual one-time login** for Google OAuth, then reuse the session cookie via axios for all API calls | Avoids automating Google login (risk of account flags); session cookie lasts ~1-2 weeks observed |
| Database | **MongoDB** (Mongoose) | Matches your existing stack |
| Session storage | **AWS S3** (`storageState.json`) | So any deployed instance can pick up the latest session after you manually re-login |
| Admin alerts | **Telegram bot** (simplest, free, no template approval) | Used to notify you when portal session expires (401) |

---

## 3. Architecture Diagram

```
Placement Portal (Next.js frontend, Google OAuth + Better Auth session + JWT API)
        │
        │  (Playwright — ONE-TIME MANUAL login → storageState.json → uploaded to S3)
        ▼
Placement Synchronizer  (BullMQ repeatable job, every 5 min)
        │   1. Download latest storageState.json from S3
        │   2. GET /api/auth/token  (cookie → fresh JWT)
        │   3. GET /api/post/list  (compare updatedAt vs what's in Mongo)
        │   4. For new/changed posts only:
        │        GET /api/post/{id}         → full body
        │        GET /api/attachment?postId={id} → PDFs/files
        ▼
MongoDB  (Notice collection: summary + previousSummary snapshot + timestamps)
        │
        ▼
AI Summarizer (gemini API — extracts structured fields from raw HTML body)
        │
        ▼
Diff Service (compares previousSummary vs new summary → human-readable change list)
        │
        ▼
Notification Queue (BullMQ) — "new-drive" / "notice-updated" / "deadline-reminder" jobs
        │   (rate-limited: ~1-2 sec delay between sends to avoid WhatsApp flagging)
        ▼
whatsapp-web.js client (persistent Puppeteer/Chromium session, QR-scanned once)
        │
        ▼
AIT Placement WhatsApp Group  (broadcast-only, admin-only send permission)
```

**No arrow goes back.** Students never trigger anything; it's pure broadcast.

---

## 4. Portal API Reference (reverse-engineered)

Auth flow:
```
Google OAuth (manual, one-time, via Playwright visible browser)
        │
        ▼
__Secure-better-auth.session_token   (HttpOnly, Secure, SameSite=None, ~1-2 week expiry)
        │
        ▼
GET /api/auth/token   (Cookie: __Secure-better-auth.session_token=...)
        │
        ▼
JWT   →  { "token": "eyJhbGc..." }
        │
        ▼
Authorization: Bearer <JWT>   used for all below
```

Endpoints:
```
GET /api/post/list
→ { "posts": [ { "id", "title", "createdAt", "updatedAt" }, ... ] }

GET /api/post/{id}
→ { "title", "body" (HTML), "details": [], ... }

GET /api/attachment?postId={id}
→ { "attachments": [ { "fileName", "url" }, ... ] }
```

Observed stack (for reference): Next.js frontend (Vercel), Better Auth session management, JWT-secured REST API, JSON responses.

---

## 5. Session Renewal Process (Manual, ~Every 1-2 Weeks)

**Why manual:** Automating Google's login flow (typing credentials, clicking through
consent headlessly) risks Google's automated-sign-in detection flagging your account.
Not worth the risk for a project that only needs this once every couple weeks.

**Flow:**
1. Sync worker's `getFreshJWT()` calls `/api/auth/token`. If it gets a 401 →
   sends you a Telegram alert: "Session expired, please re-login."
2. You run `npm run login` on your machine (needs a display, not the server).
3. A **visible** Chrome window opens (Playwright, `channel: 'chrome'` — uses your
   real installed Chrome, not bundled Chromium, to better match a normal browser fingerprint).
4. You log in manually with Google (handle 2FA/captcha yourself — completely normal, no automation).
5. Press Enter in the terminal once you see the dashboard.
6. Script captures `storageState.json` locally, then **uploads it straight to S3**
   (automated — no separate `aws s3 cp` step needed).
7. Next scheduled sync cycle downloads the fresh session from S3 automatically.

---

## 6. Data Model (MongoDB / Mongoose)

### `Notice` collection

```js
{
  portalPostId: String,       // unique, indexed — from portal's post.id
  title: String,
  rawBody: String,            // original HTML, kept in case you need to re-summarize
  attachments: [{ fileName, url }],

  summary: {                  // AI-extracted, current version
    company, role,
    packageOrStipend, packageLPA,      // packageLPA is numeric, for "above 12 LPA" filtering later if needed
    eligibleBranches: [String],
    eligibleBatches: [String],
    minCGPA, maxBacklogs,
    deadline: Date,
    applyLink,
    importantInstructions,
    isInternship: Boolean
  },

  previousSummary: { ...same shape... },   // snapshot BEFORE the most recent change, used for diffing

  portalCreatedAt: Date,
  portalUpdatedAt: Date,
  lastSyncedAt: Date,

  notifiedNewAt: Date,        // guards against duplicate "new drive" notifications
  notifiedUpdateAt: Date,     // guards against duplicate "updated" notifications
}
```

Indexes: `portalPostId` (unique), `portalCreatedAt` (desc), `summary.deadline`, `summary.packageLPA`.

No `User` collection needed in this final scope (no per-student registration).

---

## 7. AI Summarization — Extraction Schema

Prompt Gemini to extract ONLY this JSON shape from raw notice HTML/text:

```json
{
  "company": "string",
  "role": "string",
  "packageOrStipend": "string (human-readable, e.g. '12 LPA')",
  "packageLPA": "number | null",
  "eligibleBranches": ["string"],
  "eligibleBatches": ["string"],
  "minCGPA": "number | null",
  "maxBacklogs": "number | null",
  "deadline": "ISO 8601 date string | null",
  "applyLink": "string | null",
  "importantInstructions": "string (1-3 sentences)",
  "isInternship": "boolean"
}
```

Rules for the prompt: never invent values not supported by the text; use `null`/`[]`/`""`
for anything not determinable; respond with ONLY the JSON object, no markdown fences.

---

## 8. Diffing Logic (What Counts as an "Update")

Track these fields for changes between `previousSummary` and new `summary`:
- Deadline
- Eligible Branches
- Eligible Batches
- CGPA Criteria
- Backlog Limit
- Package/Stipend
- Important Instructions

If NONE of these changed (e.g. portal just touched an unrelated field or timestamp),
do **not** send an "updated" notification — prevents spam on cosmetic/irrelevant edits.

If something changed, generate a human-readable diff list, e.g.:
```
Deadline: 10 Jul 2026 → 12 Jul 2026
Eligible Branches: IT, CSE → IT, CSE, ENTC
```

---

## 9. Notification Types & Message Templates

### New Drive
```
🚀 NEW PLACEMENT DRIVE

🏢 Company: Microsoft
💼 Role: SDE Intern
💰 Package/Stipend: ₹80,000/month
🎓 Eligible: IT, CSE
📅 Batch: 2027
📊 CGPA: 7.5+

📅 Deadline: 10 Jul 2026

📝 [important instructions if any]

🔗 Apply Link:
https://...

📎 Attachments: JD.pdf

#Placement #Microsoft
```

### Notice Updated
```
🔄 PLACEMENT NOTICE UPDATED

🏢 Company: Microsoft
💼 Role: SDE Intern

Changes:
• Deadline: 10 Jul 2026 → 12 Jul 2026
• Eligible Branches: IT, CSE → IT, CSE, ENTC

🔗 Apply Link:
https://...
```

### Deadline Reminder (24hr before)
```
⏰ DEADLINE REMINDER

🏢 Company: Microsoft
💼 Role: SDE Intern
📅 Deadline: 10 Jul 2026

🔗 Apply now:
https://...
```

### Final Reminder (same day / EOD)
```
⚠️ FINAL REMINDER — CLOSES TODAY

🏢 Company: Microsoft
💼 Role: SDE Intern
📅 Deadline: 10 Jul 2026

🔗 Apply now:
https://...
```

### Daily Digest (sent once/morning via cron, e.g. 9 AM)
```
📰 DAILY PLACEMENT DIGEST
09 Jul 2026

New Drives (2):
• Microsoft — SDE Intern
• Mastercard — Software Engineer

Upcoming Deadlines:
• Addepar — 12 Jul 2026
```

---

## 10. Reminder Scheduling Logic

For every notice with a `deadline`, schedule TWO delayed BullMQ jobs:
- `deadline - 24 hours` → "Deadline Reminder"
- `deadline's end-of-day - 2 hours` → "Final Reminder — closes today"

Use a **deterministic job ID** per notice+type (e.g. `reminder-{noticeId}-24h`) so that
if a deadline changes, the old job is removed and replaced rather than duplicated.
Skip scheduling if the computed delay is already in the past (e.g. notice synced after its own reminder window).

---

## 11. Folder Structure (To Build Later)

```
placement-bot/
├── docker-compose.yml          # local Mongo + Redis for dev
├── Dockerfile
├── package.json
├── .env.example
├── .gitignore
├── scripts/
│   └── login.js                # one-time Playwright login + S3 upload
├── src/
│   ├── config/
│   │   ├── env.js               # centralized env var loader
│   │   ├── db.js                 # Mongoose connection
│   │   └── redis.js              # ioredis connection factory for BullMQ
│   ├── portal/
│   │   ├── portalClient.js       # all portal HTTP calls (auth, list, detail, attachments)
│   │   └── sessionManager.js     # download/upload storageState.json to/from S3
│   ├── models/
│   │   └── Notice.js             # Mongoose schema
│   ├── services/
│   │   ├── syncService.js        # orchestrates one full sync cycle
│   │   ├── diffService.js        # field-by-field change detection
│   │   └── aiSummaryService.js   # gemini API extraction call
│   ├── whatsapp/
│   │   ├── waClient.js           # whatsapp-web.js singleton client, QR login, group send
│   │   └── templates.js          # message formatting functions
│   ├── jobs/
│   │   ├── queue.js              # BullMQ queue definitions (sync, notification, reminder)
│   │   ├── syncWorker.js         # repeatable job, every 5 min, calls syncService
│   │   ├── notificationWorker.js # consumes notification queue, sends to WhatsApp group
│   │   ├── reminderWorker.js     # consumes delayed reminder jobs
│   │   └── digestWorker.js       # daily cron job for digest message
│   ├── utils/
│   │   ├── logger.js             # pino structured logger
│   │   └── adminAlert.js         # Telegram alert for session expiry / errors
│   └── index.js                  # entrypoint: connects DB, starts WA client, starts all workers
```

---

## 12. Environment Variables Needed

```
# Placement Portal
PORTAL_BASE_URL=
PORTAL_AUTH_TOKEN_PATH=/api/auth/token
PORTAL_POST_LIST_PATH=/api/post/list
PORTAL_POST_DETAIL_PATH=/api/post
PORTAL_ATTACHMENT_PATH=/api/attachment
SESSION_COOKIE_NAME=__Secure-better-auth.session_token

# MongoDB
MONGO_URI=

# Redis (BullMQ)
REDIS_HOST=
REDIS_PORT=
REDIS_PASSWORD=

# AWS S3 (storageState.json)
AWS_REGION=
S3_BUCKET_NAME=
S3_STORAGE_STATE_KEY=auth/storageState.json

# gemini
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash

# Admin Alerts (Telegram)
ADMIN_TELEGRAM_BOT_TOKEN=
ADMIN_TELEGRAM_CHAT_ID=

# Sync timing
SYNC_INTERVAL_MS=300000    # 5 minutes

# WhatsApp (whatsapp-web.js)
WHATSAPP_AUTH_FOLDER=./whatsapp_auth
WHATSAPP_SEND_DELAY_MS=1500
WHATSAPP_GROUP_ID=         # get via a one-time "list my groups" script after QR login

# Daily digest
DAILY_DIGEST_CRON=0 9 * * *

NODE_ENV=development
LOG_LEVEL=info
```

---

## 13. Key Dependencies

```
@google-ai/gemini-sdk       — gemini API calls for summarization
@aws-sdk/client-s3      — storageState.json upload/download
axios                   — portal API calls
bullmq + ioredis        — job scheduling (sync, notifications, reminders)
dayjs                   — date formatting/diffing
dotenv                  — env config
mongoose                — MongoDB models
pino (+ pino-pretty)    — structured logging
whatsapp-web.js         — WhatsApp group broadcasting (pulls in puppeteer)
playwright (dev dep)    — one-time manual portal login script
qrcode-terminal         — render WhatsApp login QR code in terminal
```

---

## 14. Build Order (Recommended Sequence)

1. **Portal sync in isolation** — `portalClient.js` + `sessionManager.js` +
   `scripts/login.js`. Get a real JWT, real post list, real detail/attachments,
   printed to console. Prove this works before anything else.
2. **Mongo + Notice model** — store synced posts, verify diffing on `updatedAt` works.
3. **AI summarization** — feed a real notice body into gemini, verify structured JSON comes back correctly.
4. **whatsapp-web.js — get a message into your test group** (skip queues at first,
   just prove you can send one message via a persistent session).
5. **BullMQ wiring** — sync worker (repeatable), notification worker, reminder worker, digest worker.
6. **Diff service + update/reminder templates** — polish the message formatting.
7. **Dockerize + deploy to AWS ECS** (mirroring your MindMap setup: container(s) for
   the WhatsApp/worker process + Redis + Mongo, or Mongo Atlas instead of self-hosted).

Rationale: steps 1-4 are each independently testable and are the "fragile" pieces
(portal auth, AI parsing, WhatsApp session) — prove those work in isolation before
wiring the orchestration layer (BullMQ) around them.

---

## 15. Known Risks / Things to Revisit

- **whatsapp-web.js ToS risk**: still technically against WhatsApp's ToS; use a
  secondary number, not your personal one; keep send-rate low (1-2 sec between messages,
  and you're only sending to ONE group so this is low volume anyway).
- **Session expiry cadence**: expect to manually re-run `npm run login` roughly
  every 1-2 weeks based on observed cookie lifetime — budget for this, don't try to automate it.
- **Portal API stability**: this is a reverse-engineered undocumented API; if the
  portal changes its auth flow or response shape, `portalClient.js` is the only
  file that needs to change (by design).
- **gemini extraction accuracy**: spot-check the AI summaries against a few real
  notices before trusting them fully — LLM extraction of dates/numbers can
  occasionally misparse ambiguous phrasing (e.g. "within a week of joining" vs an actual deadline date).