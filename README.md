# AIT Placement Bot

> A production-grade WhatsApp automation bot that monitors an AIT (Army Institute of Technology) college placement portal 24/7, intelligently summarises new notices using Google Gemini AI, and broadcasts formatted alerts to a WhatsApp group — with zero manual effort after initial setup.

---

## Table of Contents

- [Part 1 — Overview & Architecture](#part-1--overview--architecture)
  - [What It Does](#what-it-does)
  - [Tech Stack](#tech-stack)
  - [High-Level Architecture](#high-level-architecture)
  - [Project Structure](#project-structure)
- [Part 2 — Session Management & Portal Authentication](#part-2--session-management--portal-authentication)
  - [The Authentication Problem](#the-authentication-problem)
  - [Step 1: Manual Login with Playwright](#step-1-manual-login-with-playwright)
  - [Step 2: Storing the Token in S3](#step-2-storing-the-token-in-s3)
  - [Step 3: Runtime Session Restoration](#step-3-runtime-session-restoration)
  - [Step 4: JWT Exchange with the Portal API](#step-4-jwt-exchange-with-the-portal-api)
  - [Session Expiry & Admin Alerting](#session-expiry--admin-alerting)
- [Part 3 — Sync Engine, AI Summarisation & Job Queue](#part-3--sync-engine-ai-summarisation--job-queue)
  - [The Sync Cycle](#the-sync-cycle)
  - [Change Detection: MD5 Content Hashing](#change-detection-md5-content-hashing)
  - [AI Summary Extraction with Gemini](#ai-summary-extraction-with-gemini)
  - [Diff Service](#diff-service)
  - [MongoDB Notice Model](#mongodb-notice-model)
  - [BullMQ Job Queue System](#bullmq-job-queue-system)
  - [Atomic Notification Guards](#atomic-notification-guards)
- [Part 4 — WhatsApp Layer, Notification Templates, Docker & Operations](#part-4--whatsapp-layer-notification-templates-docker--operations)
  - [WhatsApp Client (whatsapp-web.js + Puppeteer)](#whatsapp-client-whatsapp-webjs--puppeteer)
  - [Message Templates](#message-templates)
  - [Admin Alerts via Telegram](#admin-alerts-via-telegram)
  - [Docker Deployment](#docker-deployment)
  - [Utility Scripts](#utility-scripts)
  - [Environment Variables Reference](#environment-variables-reference)
  - [Graceful Shutdown](#graceful-shutdown)

---

# Part 1 — Overview & Architecture

## What It Does

The bot performs the following automated tasks end-to-end, every 5 minutes:

| Action | Description |
|---|---|
| **Monitors** | Polls the AIT placement portal REST API for new or changed placement notices |
| **Detects Changes** | Uses MD5 content hashing to detect genuine content changes (ignores portal timestamp drift) |
| **Summarises** | Calls Google Gemini 2.5 Flash to extract structured data: company, role, package, eligibility, deadline, etc. |
| **Classifies** | Distinguishes new drives, follow-up announcements (shortlists, schedules), and admin-only notices |
| **Broadcasts** | Sends formatted WhatsApp messages to a student group |
| **Reminds** | Sends 24-hour and same-day deadline reminders via scheduled BullMQ jobs |
| **Digests** | Sends a daily 9 AM summary of active drives and upcoming deadlines |
| **Alerts** | Notifies the admin on Telegram if the portal session expires or WhatsApp disconnects |

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Runtime | Node.js 22 | Application server |
| Portal Auth | Playwright (dev) | Captures browser session for manual login |
| Session Storage | AWS S3 | Stores `storageState.json` for stateless cloud deployment |
| Portal API Client | Axios | JWT-authenticated REST calls to the placement portal |
| Database | MongoDB + Mongoose | Persistent notice storage with change tracking |
| Job Queue | BullMQ + Redis | Reliable async job scheduling and delivery |
| AI | Google Gemini 2.5 Flash (`@google/genai`) | Structured placement data extraction |
| WhatsApp | whatsapp-web.js + Puppeteer + Chromium | Automated WhatsApp messaging via a linked phone |
| Admin Alerts | Telegram Bot API | Out-of-band error notifications |
| Logging | Pino (+ pino-pretty in dev) | Structured JSON logging |
| Containerisation | Docker + Docker Compose | EC2 deployment with Redis sidecar |

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          AWS EC2 (Docker)                           │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    placement-bot container                    │  │
│  │                                                              │  │
│  │   src/index.js (main)                                        │  │
│  │        │                                                     │  │
│  │        ├─── connectDB()  ──────────────────► MongoDB Atlas   │  │
│  │        │                                                     │  │
│  │        ├─── initWAClient() ──► Puppeteer/Chromium            │  │
│  │        │                           │                         │  │
│  │        │                     WhatsApp Web ◄── Phone (linked) │  │
│  │        │                                                     │  │
│  │        └─── startWorkers()                                   │  │
│  │               │                                              │  │
│  │        ┌──────┴──────────────────────────────┐              │  │
│  │        │           BullMQ Workers             │              │  │
│  │        │                                      │              │  │
│  │   [syncWorker]  [notifWorker]  [reminderWorker] [digestWorker]│  │
│  │        │                                      │              │  │
│  └────────┼──────────────────────────────────────┼──────────────┘  │
│           │                                      │                  │
│           ▼                                      ▼                  │
│  ┌─────────────────┐                   ┌──────────────────┐        │
│  │  Redis (BullMQ) │                   │  MongoDB (Atlas) │        │
│  │  Queue Backend  │                   │  Notice Records  │        │
│  └─────────────────┘                   └──────────────────┘        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
           │                                      │
           ▼                                      ▼
   ┌───────────────┐                    ┌──────────────────┐
   │   AWS S3      │                    │  Gemini API      │
   │ storageState  │                    │  (AI extraction) │
   │    .json      │                    └──────────────────┘
   └───────────────┘
           │
           ▼
   ┌───────────────┐         ┌──────────────────┐
   │  Portal API   │         │  Telegram Bot    │
   │  (JWT auth)   │         │  (admin alerts)  │
   └───────────────┘         └──────────────────┘
```

### Data Flow Summary

```
Every 5 minutes (BullMQ repeatable job):

S3 ──► storageState.json ──► session cookie
                                   │
                                   ▼
                          Portal /api/auth/token ──► JWT
                                   │
                                   ▼
                          Portal /api/post/list ──► [post stubs]
                                   │
                          for each new/changed post:
                                   │
                                   ▼
                    Portal /api/post/{id}  ──► full body + attachments
                                   │
                                   ▼
                          MD5 hash (title+body+attachments)
                          compare with stored contentHash
                                   │
                          if genuinely changed:
                                   │
                                   ▼
                          Gemini API ──► structured JSON summary
                                   │
                                   ▼
                          MongoDB (upsert Notice document)
                                   │
                                   ▼
                      BullMQ notification queue
                      (new-drive / follow-up-post /
                       notice-updated / admin-announcement)
                                   │
                                   ▼
                      WhatsApp group message
```

## Project Structure

```
bot/
├── src/
│   ├── index.js                  # Main entry point — boots all services
│   ├── config/
│   │   ├── env.js                # Centralised env var loader + validation
│   │   ├── db.js                 # MongoDB connection with retry + events
│   │   └── redis.js              # ioredis connection factory (shared + per-worker)
│   ├── portal/
│   │   ├── sessionManager.js     # S3 download/upload of storageState.json + cookie extraction
│   │   └── portalClient.js       # Axios-based portal REST API client (JWT auth)
│   ├── services/
│   │   ├── syncService.js        # Core sync loop: change detection → AI → DB → queue
│   │   ├── aiSummaryService.js   # Gemini structured extraction with retry on 429
│   │   └── diffService.js        # Field-level diff of old vs new AI summary
│   ├── models/
│   │   └── Notice.js             # Mongoose schema for placement notices
│   ├── jobs/
│   │   ├── queue.js              # BullMQ Queue definitions (sync/notification/reminder/digest)
│   │   ├── syncWorker.js         # Repeatable sync job worker (every N ms)
│   │   ├── notificationWorker.js # Sends WhatsApp messages; atomic duplicate guard
│   │   ├── reminderWorker.js     # Sends deadline reminders at scheduled delays
│   │   └── digestWorker.js       # Sends daily digest at 9 AM via cron
│   ├── whatsapp/
│   │   ├── waClient.js           # whatsapp-web.js client init, sendToGroup, destroy
│   │   └── templates.js          # All WhatsApp message formatting functions
│   └── utils/
│       ├── logger.js             # Pino logger (pretty in dev, JSON in prod)
│       └── adminAlert.js         # Telegram admin alert sender
├── scripts/
│   ├── login.js                  # One-time manual login via Playwright → saves to S3
│   ├── getGroupId.js             # Lists all WhatsApp groups to find the group ID
│   ├── markOldNoticesNotified.js # Migration: silence old notices on first deploy
│   ├── testStage1.js             # Dev test: portal auth + post fetch
│   └── testStage2.js             # Dev test: AI extraction on a saved post
├── Dockerfile                    # 2-stage Docker build (deps + runtime with Chromium)
├── docker-compose.yml            # Bot + Redis sidecar for EC2 deployment
├── .env.example                  # Template for all required environment variables
└── package.json                  # NPM scripts: start, dev, login, get-group-id, etc.
```

---

# Part 2 — Session Management & Portal Authentication

## The Authentication Problem

The AIT placement portal uses **Google OAuth with better-auth** — a full browser login flow that cannot be scripted with a simple username/password POST. The portal relies on:

1. A browser-based Google OAuth redirect
2. An HTTP-only secure cookie (`__Secure-better-auth.session_token`) set after successful login
3. That cookie being sent with every API request to obtain a short-lived JWT

This poses a fundamental challenge for a headless server: **how do you authenticate a bot to a site that requires a real browser login?**

The answer is a **two-phase authentication strategy**:
- **Phase 1 (once, manually):** A developer logs in using a real Chrome window via Playwright. The full browser session state (cookies, localStorage) is captured and uploaded to AWS S3.
- **Phase 2 (automated, every sync):** The bot downloads that session state from S3, extracts the cookie, and exchanges it for a fresh JWT to call the portal's REST API.

---

## Step 1: Manual Login with Playwright

**File:** `scripts/login.js` | **Command:** `npm run login`

Run **once** by the developer on their local machine. It:

1. Launches a real visible Chrome window (`headless: false`, `channel: 'chrome'`)
2. Navigates to the portal base URL
3. Waits for the developer to complete Google OAuth login, 2FA, captcha manually
4. Captures the full browser session once Enter is pressed:

```javascript
await context.storageState({ path: STORAGE_STATE_PATH });
```

Playwright's `storageState()` dumps all cookies (including HTTP-only), localStorage, and sessionStorage into a JSON file:

```json
{
  "cookies": [
    {
      "name": "__Secure-better-auth.session_token",
      "value": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
      "domain": "placement.ait.ac.in",
      "path": "/",
      "expires": 1758000000,
      "httpOnly": true,
      "secure": true,
      "sameSite": "Strict"
    }
  ],
  "origins": []
}
```

> **Why Playwright and not Puppeteer?**  
> Playwright's `context.storageState()` is a first-class API built exactly for this use-case. The `--disable-blink-features=AutomationControlled` flag also prevents Google from detecting the automation.

---

## Step 2: Storing the Session in S3

**File:** `src/portal/sessionManager.js`

After capturing the session state, the login script immediately uploads it to AWS S3:

```javascript
// PutObjectCommand from @aws-sdk/client-s3
const command = new PutObjectCommand({
  Bucket: env.s3BucketName,
  Key: env.s3StorageStateKey,    // default: "auth/storageState.json"
  Body: fs.readFileSync(localFilePath),
  ContentType: 'application/json',
});
await s3.send(command);
```

**Why S3 and not the container filesystem?**

| Problem with local storage | How S3 solves it |
|---|---|
| File lost on every container restart | S3 is persistent, independent of container lifecycle |
| File lost on every redeployment | S3 survives all deploys |
| Can't update without SSH-ing into EC2 | Upload from laptop → bot picks it up next cycle automatically |
| Credential management | EC2 IAM role gives access — no keys hardcoded |

**S3 object key:** `s3://<S3_BUCKET_NAME>/auth/storageState.json`

**Session lifetime:** The Google OAuth token typically lasts **1–2 weeks**. When it expires, the bot fires a Telegram alert and the admin runs `npm run login` locally. S3 is updated and the bot recovers on its own next cycle.

---

## Step 3: Runtime Session Restoration

**File:** `src/portal/sessionManager.js`

At the **start of every sync cycle**, the bot re-downloads `storageState.json` from S3:

```javascript
async function downloadStorageState() {
  const response = await s3.send(new GetObjectCommand({
    Bucket: env.s3BucketName,
    Key: env.s3StorageStateKey,
  }));

  // Stream S3 body directly to disk — avoids buffering entire file in memory
  await new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(LOCAL_STORAGE_STATE_PATH);
    response.Body.pipe(writeStream);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });
}
```

The file lands at `<cwd>/storageState.json`. It is **never persisted** across restarts — always freshly pulled from S3. This is deliberate: if the admin uploads a renewed session while the bot is live, the very next cycle picks it up with no restart needed.

The session cookie is then extracted:

```javascript
function extractSessionCookie() {
  const state = JSON.parse(fs.readFileSync(LOCAL_STORAGE_STATE_PATH, 'utf-8'));
  // env.sessionCookieName = '__Secure-better-auth.session_token'
  const cookie = state.cookies.find(c => c.name === env.sessionCookieName);
  return cookie?.value || null;
}
```

---

## Step 4: JWT Exchange with the Portal API

**File:** `src/portal/portalClient.js`

The session cookie is exchanged for a short-lived **Bearer JWT** before any data calls:

```javascript
async function getFreshJWT(sessionCookieValue) {
  const response = await axios.get(`${env.portalBaseUrl}/api/auth/token`, {
    headers: {
      Cookie: `__Secure-better-auth.session_token=${sessionCookieValue}`,
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ...',
    },
    timeout: 15000,
  });
  return response.data.token; // short-lived JWT
}
```

The spoofed `User-Agent` makes the request look like a real browser, reducing risk of bot-detection blocks at the server level.

All subsequent portal API calls in that cycle use this JWT:

| Endpoint | Purpose |
|---|---|
| `GET /api/auth/token` | Cookie → JWT |
| `GET /api/post/list` | All post stubs (id, title, updatedAt) |
| `GET /api/post/{id}` | Full post body + metadata |
| `GET /api/attachment?postId={id}` | File attachments |

**Complete auth chain per sync cycle:**

```
[AWS S3]  auth/storageState.json
    │  (GetObjectCommand → streamed to disk)
    ▼
[disk]  storageState.json
    │  (JSON.parse → find cookie by name)
    ▼
[cookie value]  __Secure-better-auth.session_token=eyJ...
    │  (axios GET /api/auth/token, Cookie: header)
    ▼
[JWT]  eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
    │  (Authorization: Bearer <JWT>)
    ├──► GET /api/post/list
    ├──► GET /api/post/{id}
    └──► GET /api/attachment?postId={id}
```

---

## Session Expiry & Admin Alerting

When the session cookie expires, `/api/auth/token` returns **HTTP 401**. The client detects this and:

1. Fires a Telegram alert to the admin with instructions
2. Throws `SESSION_EXPIRED` to abort the current sync cycle

```javascript
if (err.response?.status === 401) {
  await sendAlert(
    '⚠️ *Portal Session Expired*\n\n' +
    'Run `npm run login` on your machine to re-authenticate and upload a fresh storageState to S3.'
  );
  throw new Error('SESSION_EXPIRED');
}
```

The bot continues running — it skips sync cycles until a new `storageState.json` is uploaded to S3, at which point it self-heals on the next cycle with zero manual intervention on the server.

---

# Part 3 — Sync Engine, AI Summarisation & Job Queue

## The Sync Cycle

**File:** `src/services/syncService.js` → triggered by `src/jobs/syncWorker.js`

The sync engine is the brain of the bot. It runs on a **BullMQ repeatable job** every `SYNC_INTERVAL_MS` milliseconds (default: 300,000ms = 5 minutes). The worker has `concurrency: 1` — only one sync ever runs at a time.

The full sync cycle (`runSync()`) executes these steps:

```
1. downloadStorageState()          ← pull fresh session from S3
2. extractSessionCookie()          ← read cookie from storageState.json
3. getFreshJWT(cookie)             ← exchange cookie for JWT
4. fetchPostList(jwt)              ← get all post stubs from portal
5. for each post in list:
   a. Fetch from DB: findOne({ portalPostId })
   b. GATE 1: isNew || portalTimestampChanged? → if no, skip
   c. fetchPostDetail(jwt, postId)  ← fetch full body (parallel with attachments)
   d. fetchAttachments(jwt, postId) ← fetch file list
   e. Compute MD5 content hash
   f. GATE 2: contentHash changed? → if no, update timestamp only, skip
   g. extractSummary(title, body)   ← call Gemini AI
   h. diffSummary(old, new)         ← compute field-level diff
   i. Notice.findOneAndUpdate(...)  ← upsert to MongoDB
   j. Queue appropriate BullMQ job
6. retryEmptySummaries()           ← retry any previous failed AI extractions
```

The two-gate design is a key performance optimisation: the first gate (portal `updatedAt` string) filters out the vast majority of posts on every cycle without a DB read. The second gate (MD5 hash) is the definitive truth and prevents false positives from relative timestamp drift (e.g. "1 day ago" → "2 days ago" without any real content change).

---

## Change Detection: MD5 Content Hashing

**File:** `src/services/syncService.js`

### The Problem: Relative Timestamps

The portal returns `updatedAt` values as relative strings like `"1 day ago"`, `"2 days ago"`. These strings change every day even when the post content hasn't changed at all. Naively treating a `portalUpdatedAt` change as a content change would cause the bot to fire AI calls and notifications for unmodified posts every single day.

### The Solution: MD5 Hash

For every post that passes the first gate, the bot computes a deterministic hash over the actual content:

```javascript
const newContentHash = crypto
  .createHash('md5')
  .update(post.title + newRawBody + JSON.stringify(newAttachments))
  .digest('hex');
```

The hash input is: **post title** + **full HTML body** + **attachments array (as JSON)**. This covers all content that would be meaningful to students.

The stored hash is compared against the new hash:

```javascript
const isChanged = existing && existing.contentHash !== newContentHash;
```

| Scenario | portalUpdatedAt | contentHash | Action |
|---|---|---|---|
| Truly new post | — | — | Full processing + notify |
| Timestamp drifted, content same | Changed | Same | Update timestamp only, skip |
| Content genuinely changed | Changed | Different | Full processing + notify |
| Nothing changed | Same | Same | Skip (first gate catches this) |

### Content Hash Baseline Migration

When a notice was saved before the hash feature was deployed, it has `contentHash: null`. Comparing `null !== newHash` would be truthy and incorrectly mark it as changed. The code handles this with a baseline guard:

```javascript
if (existing && existing.contentHash === null) {
  // Establish baseline — do NOT treat as a change
  await Notice.updateOne(
    { portalPostId: postId },
    { $set: { contentHash: newContentHash, portalUpdatedAt: postUpdatedAt } }
  );
  continue; // skip this cycle, treat as baseline
}
```

---

## AI Summary Extraction with Gemini

**File:** `src/services/aiSummaryService.js`

For every genuinely new or changed post, the bot calls **Google Gemini 2.5 Flash** to extract structured placement data from the raw HTML body.

### Why Structured Output?

The portal notices are HTML blobs — they contain company names, package figures, eligibility criteria, and deadlines in unstructured natural language. Instead of asking Gemini to write a summary paragraph (which can't be reliably used for reminders, filtering, or diffs), the bot instructs Gemini to return a **strict JSON object** matching a predefined schema.

### The Schema

```javascript
const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    company:               { type: 'string' },   // e.g. "Google, Microsoft"
    role:                  { type: 'string' },   // e.g. "SDE Intern"
    packageOrStipend:      { type: 'string' },   // e.g. "12 LPA"
    packageLPA:            { type: 'number', nullable: true }, // numeric for sorting
    eligibleBranches:      { type: 'array', items: { type: 'string' } }, // ["CSE", "IT"]
    eligibleBatches:       { type: 'array', items: { type: 'string' } }, // ["2025", "2026"]
    minCGPA:               { type: 'number', nullable: true },
    maxBacklogs:           { type: 'number', nullable: true },
    deadline:              { type: 'string', nullable: true }, // ISO 8601
    applyLink:             { type: 'string', nullable: true },
    importantInstructions: { type: 'string' },   // 1-3 sentence summary
    hasShortlist:          { type: 'boolean' },  // true if a shortlist is present
    isInternship:          { type: 'boolean' },
    isFollowUp:            { type: 'boolean' },  // true for shortlist/schedule posts
  },
  required: [ /* all fields */ ]
};
```

The schema is passed to the Gemini API as `responseSchema` with `responseMimeType: 'application/json'`. This forces Gemini to return **only** a valid JSON object — no markdown fences, no explanations, no hallucinated fields.

### The Prompt

The extraction prompt is carefully engineered to handle edge cases:

- **Multi-company schedules:** If a notice has a table with 5 companies on different dates, `company` gets `"TCS, Infosys, Wipro, HCL, Tech Mahindra"` and `importantInstructions` summarises the schedule.
- **Relative dates:** The prompt explicitly says to use ISO 8601 and to return `null` for ambiguous dates ("within 2 weeks of joining" is NOT a deadline).
- **`isFollowUp` detection:** Gemini identifies whether the notice is a brand-new drive or a follow-up (shortlist, interview slots, reporting instructions) so the correct message template is used.
- **Temperature 0.1:** Very low temperature to maximise factual accuracy and minimise hallucination.

### Rate Limit Handling (429 / RESOURCE_EXHAUSTED)

Gemini's free tier has quota limits. When a 429 is received, the response body contains a `retryDelay` field with the exact wait time. The bot parses this and waits accordingly:

```javascript
function parseRetryDelay(err) {
  const body = JSON.parse(err.message);
  const retryInfo = body?.error?.details?.find(
    d => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo'
  );
  if (retryInfo?.retryDelay) {
    // e.g. "17.923234888s" → 18923ms + 1000ms buffer
    return Math.ceil(parseFloat(retryInfo.retryDelay) * 1000) + 1000;
  }
  return 20_000; // safe default
}
```

The extraction retries up to **3 times** with the API-suggested delay. If all attempts fail, it returns an **empty summary** (`company: '', role: ''`) and the notice is saved without triggering a notification.

### Empty Summary Recovery

At the end of every sync cycle, `retryEmptySummaries()` finds all notices with empty summaries that haven't been sent yet, and retries the AI extraction using the already-stored `rawBody`. No portal fetch needed. If extraction succeeds, it queues a `new-drive` notification. If it still fails (the notice is genuinely a non-placement admin notice), it queues an `admin-announcement` instead.

---

## Diff Service

**File:** `src/services/diffService.js`

When a post is detected as **changed** (different content hash) and the previous AI summary exists, the diff service compares the two summaries field-by-field:

```javascript
const TRACKED_FIELDS = [
  'deadline', 'eligibleBranches', 'eligibleBatches',
  'minCGPA', 'maxBacklogs', 'packageOrStipend', 'importantInstructions'
];
```

Only these 7 semantically meaningful fields are compared. Changes to fields like `company` or `role` would indicate a fundamentally different notice and would be treated as a new post, not an update.

The diff produces human-readable change lines:

```
• Deadline: — → 25 Jul 2025
• Eligible Branches: CSE → CSE, IT
• Min CGPA: 7.5 → 7.0
```

These lines are attached to the `notice-updated` BullMQ job and included verbatim in the WhatsApp update message. If the diff shows **no semantic changes** (e.g. only `importantInstructions` minor wording), `hasChanges: false` is returned and no notification is queued.

---

## MongoDB Notice Model

**File:** `src/models/Notice.js`

Every placement notice is stored as a single MongoDB document in the `notices` collection:

```javascript
{
  // Portal identity
  portalPostId:    String,   // unique — the portal's own post ID
  title:           String,
  rawBody:         String,   // raw HTML body (preserved for AI re-extraction)
  attachments:     [{ fileName: String, url: String }],

  // AI-extracted structured data
  summary: {
    company, role, packageOrStipend, packageLPA,
    eligibleBranches, eligibleBatches,
    minCGPA, maxBacklogs, deadline, applyLink,
    importantInstructions, hasShortlist,
    isInternship, isFollowUp
  },

  // Snapshot before last change (for diffing)
  previousSummary: { ...same shape as summary... },

  // Change tracking
  portalCreatedAt: String,   // portal's own created timestamp string
  portalUpdatedAt: String,   // portal's own updated timestamp string
  lastSyncedAt:    Date,     // when this bot last successfully synced it
  contentHash:     String,   // MD5 of (title + rawBody + attachments JSON)

  // Notification guards (prevent duplicate sends)
  notifiedNewAt:   Date,     // set when new-drive/follow-up/admin message is sent
  notifiedUpdateAt: Date,    // set when notice-updated message is sent
  pendingAdminAt:  Date,     // set when admin-announcement is queued (prevents re-queue)

  // Mongoose auto-timestamps
  createdAt:       Date,
  updatedAt:       Date
}
```

**Indexes:**
- `portalPostId`: unique index (primary lookup key)
- `portalCreatedAt: -1`: for daily digest sorting
- `summary.deadline: 1`: for upcoming deadline queries
- `summary.packageLPA: 1`: for future salary-based filtering

---

## BullMQ Job Queue System

**File:** `src/jobs/queue.js`

The bot uses **4 named BullMQ queues** backed by Redis, each processed by a dedicated worker:

| Queue | Worker | Purpose |
|---|---|---|
| `sync` | `syncWorker.js` | Repeatable job that triggers `runSync()` every N ms |
| `notification` | `notificationWorker.js` | Sends WhatsApp messages for new/updated/admin notices |
| `reminder` | `reminderWorker.js` | Sends deadline reminders at calculated future delays |
| `digest` | `digestWorker.js` | Sends daily morning digest (cron: `0 9 * * *`) |

All queues share a **single Redis connection** for queue management, but each worker gets its **own independent Redis connection** (`createRedisConnection()`). This is a BullMQ requirement — workers must not share the same connection as the queues to avoid blocking.

### Sync Worker

```javascript
// Registers a repeatable job (idempotent — safe to call on every startup)
await syncQueue.add('sync-portal', {}, {
  repeat: { every: env.syncIntervalMs },
  jobId: 'sync-portal-repeatable',
});
```

The `jobId` is deterministic. Calling `syncQueue.add()` with the same `jobId` on every startup is idempotent — BullMQ deduplicates it. Concurrency is set to `1` to ensure only one sync runs at a time.

### Notification Worker

Handles 4 job types: `new-drive`, `follow-up-post`, `notice-updated`, `admin-announcement`. Uses a rate limiter to space out WhatsApp sends:

```javascript
{
  concurrency: 1,
  limiter: { max: 1, duration: env.whatsappSendDelayMs } // default 1500ms between sends
}
```

### Reminder Worker

The sync service schedules reminders at the time a new drive is detected, using calculated `delay` values:

```javascript
// 24-hour reminder
await reminderQueue.add('deadline-reminder', { noticeId }, {
  delay: deadline.subtract(24, 'hour').diff(now),
  jobId: `reminder-${noticeId}-24h`,   // deterministic — re-scheduling replaces old job
  removeOnComplete: true,
});

// Same-day final reminder (2 hours before end of deadline day)
await reminderQueue.add('final-reminder', { noticeId }, {
  delay: deadline.endOf('day').subtract(2, 'hour').diff(now),
  jobId: `reminder-${noticeId}-final`,
  removeOnComplete: true,
});
```

Redis persists these delayed jobs across bot restarts — reminders are not lost if the container restarts.

### Digest Worker

Registered as a cron job:

```javascript
await digestQueue.add('daily-digest', {}, {
  repeat: { pattern: env.dailyDigestCron }, // default: "0 9 * * *"
  jobId: 'daily-digest-cron',
});
```

At 9 AM every day, it queries MongoDB for:
- Notices created since start of today (new drives)
- Notices with deadline in the next 3 days

If nothing qualifies, the send is skipped entirely.

---

## Atomic Notification Guards

The bot uses **MongoDB `findOneAndUpdate` with an atomic conditional** as a distributed lock to guarantee each notification is sent **exactly once**, even across BullMQ retries.

### New Drive Guard

```javascript
// Only ONE execution wins — the one that finds notifiedNewAt: null
const claimed = await Notice.findOneAndUpdate(
  { _id: noticeId, notifiedNewAt: null },     // condition
  { $set: { notifiedNewAt: new Date() } },    // set the guard
  { returnDocument: 'after' }
);

if (!claimed) return; // another execution already claimed this — skip

await sendToGroup(formatNewDrive(notice));
```

If the WhatsApp send fails after the DB write and BullMQ retries the job, the second attempt finds `notifiedNewAt` already set and exits cleanly. The message was already delivered, so this is correct behaviour.

### Update Guard

For `notice-updated` jobs, the guard is more nuanced — it must allow future genuine updates to the same notice while preventing retry duplicates:

```javascript
const claimed = await Notice.findOneAndUpdate(
  {
    _id: noticeId,
    $or: [
      { notifiedUpdateAt: null },                        // never notified for update
      { notifiedUpdateAt: { $lt: notice.lastSyncedAt } } // notified before this change event
    ],
  },
  { $set: { notifiedUpdateAt: new Date() } }
);
```

`lastSyncedAt` acts as the change-event identifier. If the notice changes twice, `lastSyncedAt` advances and the second update passes the guard on the legitimate second job.

---

# Part 4 — WhatsApp Layer, Notification Templates, Docker & Operations

## WhatsApp Client (whatsapp-web.js + Puppeteer)

**File:** `src/whatsapp/waClient.js`

The bot sends messages by automating a **real WhatsApp Web session** using `whatsapp-web.js`, which drives a headless Chromium browser via Puppeteer. This is fundamentally different from the official WhatsApp Business API — it works with a regular WhatsApp account linked via QR code.

### Initialization

```javascript
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: env.whatsappAuthFolder }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--disable-crash-reporter',
      '--disable-extensions',
      '--remote-debugging-port=0',   // prevents singleton port conflict on restart
    ],
  },
});
```

**Key design decisions in the Puppeteer flags:**

| Flag | Reason |
|---|---|
| `--no-sandbox` | Required in Docker (running as non-root still, but container lacks kernel namespace for sandbox) |
| `--disable-dev-shm-usage` | `/dev/shm` is too small in Docker by default; this tells Chromium to use `/tmp` instead |
| `--single-process` | Reduces memory usage significantly for a low-traffic bot |
| `--disable-gpu` | No GPU in a headless server |
| `--remote-debugging-port=0` | Avoids the Chromium "singleton lock" error on container restart by using a random port each time |

### Auth Strategy: LocalAuth

`LocalAuth` persists the WhatsApp session to disk at `env.whatsappAuthFolder` (`./whatsapp_auth`). Once the QR is scanned for the first time, every subsequent startup reuses the saved session — no QR scan needed again.

In Docker, this folder is mounted as a **named volume** (`wa_auth_data`) so the session survives container restarts and redeployments:

```yaml
volumes:
  - wa_auth_data:/app/whatsapp_auth
```

### First-Time QR Flow

On the very first run (or after auth is deleted), the client emits a `qr` event. The bot renders the QR code in the terminal using `qrcode-terminal`:

```javascript
client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
});
```

The developer SSHs into the EC2 instance, runs `docker logs -f placement-bot`, scans the QR with their phone, and the session is saved permanently.

### Startup Wait

`initWAClient()` returns a Promise that resolves only when the `ready` event fires, with a 120-second timeout:

```javascript
await new Promise((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error('WhatsApp init timed out after 120s')),
    120_000
  );
  client.once('ready', () => { clearTimeout(timeout); resolve(); });
  client.once('auth_failure', (msg) => reject(new Error(`Auth failed: ${msg}`)));
  client.initialize().catch(reject);
});
```

The main startup sequence blocks at this step — the bot does not start sync workers until WhatsApp is confirmed ready.

### Disconnect Handling

If WhatsApp disconnects (e.g. the linked phone loses internet, the session is revoked):

```javascript
client.on('disconnected', (reason) => {
  isReady = false;
  sendAlert(`⚠️ *WhatsApp Disconnected*\nReason: ${reason}\nBot will attempt to reconnect.`);
});
```

An admin Telegram alert is sent. `whatsapp-web.js` will attempt auto-reconnect internally.

### Sending Messages

```javascript
async function sendToGroup(message) {
  if (!isReady || !client) throw new Error('WhatsApp client not ready');
  await client.sendMessage(env.whatsappGroupId, message);
}
```

The `whatsappGroupId` is a serialized chat ID in the format `XXXXXXXXXX-XXXXXXXXXX@g.us`, obtained once using the `npm run get-group-id` helper script.

---

## Message Templates

**File:** `src/whatsapp/templates.js`

The bot has **7 distinct message formats**, each corresponding to a specific notification type. All messages use plain text with emoji — no HTML, no markdown (WhatsApp Web uses its own formatting syntax but plain text is safest for group compatibility).

### 1. New Placement Drive (`formatNewDrive`)

Triggered by: `new-drive` job (for placement drives where `isFollowUp: false`)

```
🚀 NEW PLACEMENT DRIVE

🏢 Company: Google
💼 Role: Software Engineer
💰 Package/Stipend: 24 LPA
🎓 Eligible: CSE, IT
📅 Batch: 2025, 2026
📊 CGPA: 7.5+
📋 Max Backlogs: 0

⏰ Deadline: 25 Jul 2025

📝 Apply via the placement portal. Bring your updated resume.

🔗 Apply Link:
https://placement.ait.ac.in/apply/google

#Placement #Google
```

### 2. Placement Update / Follow-Up (`formatFollowUpPost`)

Triggered by: `follow-up-post` job (for notices where `isFollowUp: true` — e.g., shortlists, interview schedules)

```
📋 PLACEMENT UPDATE

🏢 Company: Microsoft
💼 Role: SDE

📝 Shortlisted candidates: [names]. Report to TPO office at 9 AM on 20 Jul.

📎 Attachments: shortlist_microsoft.pdf

#Placement #Microsoft
```

### 3. Notice Updated (`formatNoticeUpdated`)

Triggered by: `notice-updated` job when `diffSummary()` finds meaningful field changes

```
🔄 PLACEMENT NOTICE UPDATED

🏢 Company: Infosys
💼 Role: Systems Engineer

Changes:
• Deadline: — → 30 Jul 2025
• Eligible Branches: CSE → CSE, IT, ENTC
• Package/Stipend: 3.6 LPA → 4.5 LPA

🔗 Apply Link:
https://placement.ait.ac.in/apply/infosys
```

### 4. Admin Announcement (`formatAdminAnnouncement`)

Triggered by: `admin-announcement` job when Gemini cannot extract any company name (i.e., the notice is a general office announcement, not a placement drive)

```
📢 PLACEMENT OFFICE ANNOUNCEMENT

📌 Important Notice Regarding AMCAT Registration

Students are advised to register for AMCAT by 15 July 2025...
[full notice body stripped of HTML tags]

#Placement #Notice
```

HTML is stripped using a lightweight regex-based `stripHtml()` function in `templates.js` (handles `<br>`, `<li>`, `<p>`, HTML entities, etc.).

### 5. 24-Hour Deadline Reminder (`formatDeadlineReminder`)

Triggered by: `deadline-reminder` BullMQ job (scheduled at drive-detection time, fires 24h before deadline)

```
⏰ DEADLINE REMINDER

🏢 Company: TCS
💼 Role: Ninja
📅 Deadline: 20 Jul 2025

🔗 Apply now:
https://placement.ait.ac.in/apply/tcs
```

### 6. Same-Day Final Reminder (`formatFinalReminder`)

Triggered by: `final-reminder` BullMQ job (fires 2 hours before end of deadline day)

```
⚠️ FINAL REMINDER — CLOSES TODAY

🏢 Company: TCS
💼 Role: Ninja
📅 Deadline: 20 Jul 2025

🔗 Apply now:
https://placement.ait.ac.in/apply/tcs
```

### 7. Daily Morning Digest (`formatDailyDigest`)

Triggered by: `daily-digest` cron job every morning at 9 AM

```
📰 DAILY PLACEMENT DIGEST
16 Jul 2025

New Drives (2):
• Google — Software Engineer
• Amazon — SDE Intern

Upcoming Deadlines:
• TCS — 18 Jul 2025
• Infosys — 19 Jul 2025
```

---

## Admin Alerts via Telegram

**File:** `src/utils/adminAlert.js`

A lightweight Telegram Bot API integration used for out-of-band administrative notifications. It is used for two critical events:

| Event | Alert Message |
|---|---|
| Portal session expired (HTTP 401) | "Portal Session Expired — run npm run login" |
| WhatsApp client disconnected | "WhatsApp Disconnected — reason: {reason}" |
| WhatsApp auth failure | "WhatsApp Auth Failure — delete auth folder and re-scan" |

```javascript
async function sendAlert(text) {
  if (!env.adminTelegramBotToken || !env.adminTelegramChatId) {
    logger.warn('Telegram not configured — alert skipped');
    return;
  }
  await axios.post(
    `https://api.telegram.org/bot${env.adminTelegramBotToken}/sendMessage`,
    { chat_id: env.adminTelegramChatId, text, parse_mode: 'Markdown' },
    { timeout: 10000 }
  );
}
```

**Critical design:** The function **never throws**. All errors are caught and logged. A failed Telegram alert must never crash the main process — it's a secondary notification system.

---

## Docker Deployment

### Dockerfile — Two-Stage Build

**File:** `Dockerfile`

```dockerfile
# Stage 1: deps — install production dependencies only
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev   # excludes playwright, nodemon

# Stage 2: runtime — final image with Chromium
FROM node:22-slim AS runtime

# Install system Chromium + all required shared libraries for whatsapp-web.js
RUN apt-get install -y chromium fonts-liberation libatk-bridge2.0-0 \
    libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libnspr4 \
    libnss3 libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 \
    libxrandr2 xdg-utils ca-certificates

# Tell Puppeteer to use system Chromium — skip its own download
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV XDG_CONFIG_HOME=/tmp
ENV XDG_CACHE_HOME=/tmp

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Run as non-root for security
RUN groupadd -r botuser && useradd -r -g botuser botuser \
    && chown -R botuser:botuser /app
USER botuser

# Remove Chromium singleton lock on startup (leftover from unclean previous shutdown)
CMD sh -c 'find /app/whatsapp_auth -name "SingletonLock" -delete 2>/dev/null || true \
           && node src/index.js'
```

The two-stage build ensures the final image doesn't contain `devDependencies` (Playwright, Nodemon) and the dependency layer is cached separately for faster rebuilds.

The `SingletonLock` deletion in the CMD is a critical reliability fix — Chromium writes a lock file that prevents a second instance from starting on the same profile. If the container crashes without a graceful shutdown, this lock is not cleaned up and the next startup fails. The CMD proactively removes it.

### docker-compose.yml

```yaml
services:
  bot:
    build: .
    container_name: placement-bot
    restart: unless-stopped
    env_file: .env
    environment:
      - REDIS_HOST=redis          # use the Redis service name — not localhost
      - REDIS_PORT=6379
      - NODE_ENV=production
      - TZ=Asia/Kolkata           # ensures cron times are in IST
    volumes:
      - wa_auth_data:/app/whatsapp_auth   # WhatsApp session persists
    depends_on:
      - redis

  redis:
    image: redis:7-alpine
    container_name: placement-bot-redis
    restart: unless-stopped
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes   # AOF persistence for BullMQ jobs

volumes:
  wa_auth_data:   # WhatsApp LocalAuth session
  redis_data:     # BullMQ job queue persistence
```

**Named volumes ensure:**
- `wa_auth_data` — WhatsApp session survives container restarts and `docker compose up --build`
- `redis_data` — BullMQ delayed jobs (reminders) are not lost on Redis restart

### Deployment Commands

```bash
# First deploy
docker compose up -d --build

# View live logs
docker logs -f placement-bot

# Redeploy after code change (zero-downtime — session volume preserved)
docker compose up -d --build

# Restart without rebuild
docker compose restart bot

# Stop everything
docker compose down
```

---

## Utility Scripts

| Script | Command | Purpose |
|---|---|---|
| `scripts/login.js` | `npm run login` | **Most important.** One-time / periodic manual login to capture & upload session to S3. Run locally when bot sends a "session expired" Telegram alert. |
| `scripts/getGroupId.js` | `npm run get-group-id` | One-time helper. Connects WhatsApp, lists all groups your number is in with their serialized IDs. Copy the ID into `WHATSAPP_GROUP_ID` in `.env`. |
| `scripts/markOldNoticesNotified.js` | `node scripts/markOldNoticesNotified.js` | Migration utility. Run **once** before first live deployment on an existing DB. Marks all previously-synced notices as already-notified so the bot doesn't blast the whole history on first boot. Also unblocks any admin announcements that were incorrectly pre-marked by an older buggy version. |
| `scripts/testStage1.js` | `npm run test:stage1` | Dev testing. Exercises the full auth chain (S3 → cookie → JWT → post list → one post detail) and prints results. Useful to verify portal connectivity without running the full bot. |
| `scripts/testStage2.js` | `npm run test:stage2` | Dev testing. Feeds a saved post body directly into the AI extraction pipeline and prints the structured summary. Useful for tuning the Gemini prompt without touching the portal. |

---

## Environment Variables Reference

Copy `.env.example` to `.env` and fill in these values:

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORTAL_BASE_URL` | ✅ | — | Base URL of the placement portal (e.g. `https://placement.ait.ac.in`) |
| `PORTAL_AUTH_TOKEN_PATH` | | `/api/auth/token` | Path to JWT exchange endpoint |
| `PORTAL_POST_LIST_PATH` | | `/api/post/list` | Path to post list endpoint |
| `PORTAL_POST_DETAIL_PATH` | | `/api/post` | Path prefix for post detail (appended with `/{id}`) |
| `PORTAL_ATTACHMENT_PATH` | | `/api/attachment` | Path to attachment endpoint |
| `SESSION_COOKIE_NAME` | | `__Secure-better-auth.session_token` | Name of the session cookie to extract |
| `MONGO_URI` | ✅ | — | Full MongoDB connection string including database name |
| `REDIS_HOST` | ✅ | `localhost` | Redis server hostname (`redis` in docker-compose) |
| `REDIS_PORT` | ✅ | `6379` | Redis port |
| `REDIS_PASSWORD` | | — | Redis password (leave empty if none) |
| `AWS_REGION` | ✅ | — | AWS region of your S3 bucket (e.g. `ap-south-1`) |
| `S3_BUCKET_NAME` | ✅ | — | Name of the S3 bucket storing `storageState.json` |
| `S3_STORAGE_STATE_KEY` | | `auth/storageState.json` | S3 object key path |
| `GEMINI_API_KEY` | ✅ | — | Google AI Studio API key |
| `GEMINI_MODEL` | | `gemini-2.5-flash` | Gemini model ID to use |
| `ADMIN_TELEGRAM_BOT_TOKEN` | | — | Telegram bot token for admin alerts (optional but recommended) |
| `ADMIN_TELEGRAM_CHAT_ID` | | — | Your Telegram user/chat ID for receiving alerts |
| `SYNC_INTERVAL_MS` | | `300000` | Portal sync interval in milliseconds (default: 5 minutes) |
| `WHATSAPP_AUTH_FOLDER` | | `./whatsapp_auth` | Directory for WhatsApp LocalAuth session data |
| `WHATSAPP_SEND_DELAY_MS` | | `1500` | Delay between consecutive WhatsApp sends (rate limiter) |
| `WHATSAPP_GROUP_ID` | | — | Target WhatsApp group ID (get via `npm run get-group-id`) |
| `DAILY_DIGEST_CRON` | | `0 9 * * *` | Cron expression for daily digest (default: 9 AM daily) |
| `NODE_ENV` | | `development` | `production` enables JSON logs and disables pino-pretty |
| `LOG_LEVEL` | | `info` | Pino log level (`debug`, `info`, `warn`, `error`) |

---

## Graceful Shutdown

**File:** `src/index.js`

The main process listens for `SIGTERM` (Docker `docker stop`) and `SIGINT` (Ctrl+C) and shuts down cleanly:

```javascript
async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down gracefully...');

  // Close all 4 BullMQ workers (drains pending jobs, stops accepting new ones)
  await Promise.allSettled(workers.map(w => w.close()));

  // Destroy Puppeteer/Chromium and WhatsApp session
  await destroyClient();

  // Close MongoDB connection
  await disconnectDB();

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
```

`Promise.allSettled` is used (not `Promise.all`) so a failure in closing one worker doesn't prevent others from shutting down. The Chromium session is explicitly destroyed so it doesn't leave a `SingletonLock` file — though the Dockerfile CMD also handles the cleanup case where the lock is left behind.

---

## Logging

**File:** `src/utils/logger.js`

The bot uses **Pino** — the fastest structured JSON logger for Node.js. In development, `pino-pretty` formats logs with colours and human-readable timestamps. In production (`NODE_ENV=production`), raw JSON lines are emitted — suitable for log aggregation services (CloudWatch, Datadog, etc.).

Every module creates a **child logger** with a `module` label:

```javascript
const logger = require('../utils/logger').child({ module: 'syncService' });
logger.info({ postId, isNew }, 'Processing post');
// → {"level":30,"time":"...","module":"syncService","postId":"123","isNew":true,"msg":"Processing post"}
```

This makes it trivial to filter logs by module in production:
```bash
docker logs placement-bot 2>&1 | grep '"module":"syncService"'
```

---

*Built with ❤️ for AIT students — never miss a placement drive again.*
