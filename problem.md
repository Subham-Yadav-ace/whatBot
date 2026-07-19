# Problems Faced During AIT Placement Bot Development & Deployment

This document summarizes the major technical challenges, bugs, and workflow issues encountered while building and deploying the AIT Placement Bot.

## 1. Docker & Environment Issues
- **Chromium SingletonLock Crash:** If the bot container crashed or was stopped abruptly, Chromium left behind a `SingletonLock` file in the persistent WhatsApp session volume (`.wwebjs_auth`). On subsequent restarts, Chromium falsely detected another process using the profile and crashed in a continuous `Restarting` loop.
  - **Fix:** Ran a targeted command to find and delete the corrupted lock file from the Docker volume (`docker compose run --rm --entrypoint "find" bot /app/whatsapp_auth -name "Singleton*" -delete`) to restore functionality without losing the session.
- **Chromium Crashpad Error:** When running Puppeteer inside a Docker container with a non-root user, Chromium crashed with the error `chrome_crashpad_handler: --database is required`. It lacked write access to default configuration folders.
  - **Fix:** Added `XDG_CONFIG_HOME=/tmp` and `XDG_CACHE_HOME=/tmp` to the Dockerfile to provide writable temporary directories, and passed `--disable-crash-reporter` to the Puppeteer launch arguments.
- **Node 22 and `npm ci` Strictness:** Upgrading the Docker base image to `node:22-slim` caused builds to fail during `npm ci` due to slight lockfile mismatches with optional dependencies (like `gcp-metadata`).
  - **Fix:** Switched from `npm ci` to `npm install --omit=dev` in the Dockerfile, which is more lenient with lockfile inconsistencies during production builds.
- **Git State Conflicts on EC2:** Minor manual edits made directly to files on the EC2 server (like testing changes in the Dockerfile) prevented `git pull` from retrieving the latest code pushed from the local machine.
  - **Fix:** Used `git fetch origin` and `git reset --hard origin/main` to force the EC2 instance to completely mirror the GitHub repository.
- **Missing Puppeteer System Dependencies:** Running headless Chrome in a barebones Linux cloud server required installing multiple system-level shared libraries that were not present by default.

## 2. API & Data Handling Challenges
- **Gemini AI Empty Summaries (Rate Limits):** During testing and early deployment, the Google Gemini API would occasionally fail to extract details or hit rate limits, resulting in empty summary messages being generated.
  - **Fix:** Implemented a robust fallback mechanism. Failed extractions are now saved silently to the database without spamming the WhatsApp group. A `retryEmptySummaries()` function runs at the end of the sync cycle to re-process these posts when the AI becomes available again.
- **Session Persistence Across Environments:** The bot requires session persistence (cookies/tokens) to avoid logging into the portal repeatedly. Initially, storing `storageState.json` locally on the filesystem caused issues on the cloud, as the session would wipe every time the Docker container restarted.
  - **Fix:** Integrated an AWS S3 bucket to upload and download the session state. The bot now pulls the authentication state from S3 on startup, ensuring persistent login across container rebuilds.
- **Duplicate Notifications on Container Restart (Idempotency):** The bot occasionally sent duplicate WhatsApp notifications for the same portal update. This occurred because the "notification sent" timestamp was saved to the database *after* the WhatsApp message was dispatched. If the Docker container restarted or crashed in the split second between sending the message and updating the database, the next sync cycle would re-queue the notification.
  - **Fix:** Refactored the `syncService` to eagerly write the `notifiedNewAt` timestamp to MongoDB *before* enqueuing the job to BullMQ. This ensures strict idempotency; even if the container crashes during processing, the database state reflects that the job is already in the queue, preventing duplicate sends.

## 3. Workflow & Orchestration
- **Manual Deployment Overhead:** Because a CI/CD pipeline hasn't been configured yet, deploying updates involves a manual multi-step loop: pushing code to GitHub locally -> SSHing into the EC2 instance -> pulling the latest code -> rebuilding and restarting the Docker containers.
- **Secure Secret Management:** Maintaining a strict separation of dummy variables in `.env.example` while ensuring the real `.env` file containing sensitive credentials (AWS keys, MongoDB URIs, Gemini API keys) was never accidentally committed to version control.
- **Bot Batch Targeting Precision:** Ensuring the bot's filtering logic correctly isolated updates exclusively for the 2026-27 batch, preventing the WhatsApp group from being spammed with notifications intended for other batches.

## 4. Architectural & API Constraints
- **WhatsApp Web Approach vs. Official API:** The project deliberately uses a web-scraping approach (via `whatsapp-web.js` / Puppeteer) instead of the Official WhatsApp Cloud API. The main reasons and challenges surrounding this decision include:
  - **Cost & Bureaucracy:** The official API requires business verification, template pre-approval by Meta, and charges per conversation for outbound notifications. This is unfeasible for a free student utility bot.
  - **Template Rigidity:** Meta strictly regulates the format of automated messages. Using the web client allows the bot to freely send dynamic, AI-generated summaries without arbitrary restrictions.
  - **Group Messaging Limitations:** The official API traditionally imposes significant restrictions on sending automated notifications to community groups, whereas a web client easily interfaces with any group the phone is a part of.
- **Headless Browser Overhead:** Running dual Puppeteer instances—one for scraping the placement portal and one for maintaining the WhatsApp Web session—consumes significant RAM and CPU. Managing this overhead on constrained cloud environments (like a t2.micro EC2 instance) can be a bottleneck.
- **Vulnerability to DOM Changes:** Because the placement portal scraping logic relies on specific HTML classes and structure, any minor visual updates made by the university administrators to the website could break the bot's extraction flow, requiring immediate code updates.
- **Session Disconnections:** WhatsApp Web requires the host phone to periodically connect to the internet. If the phone stays offline for an extended period, the session drops, and the bot needs to be re-authenticated via QR code scan via the EC2 logs.


## 5. Notification Delivery Bugs (Jul 13, 2026)

### 5.1 New-Drive Notifications Silently Dropped (Critical Bug)
- **Problem:** New placement drives were being correctly detected and saved to the database, but the WhatsApp notification was **never actually sent** to the group. The bot appeared to be working (no errors in logs) but students received no new-drive messages.
- **Root Cause:** A design conflict between `syncService.js` and `notificationWorker.js`. The `syncService` was pre-emptively writing `notifiedNewAt = now` to MongoDB **before** adding the job to the BullMQ queue (intended as a crash-safety guard). The worker then checked `if (notice.notifiedNewAt) return` and saw the field already set — so it skipped sending on **every** execution. The guard meant to prevent duplicates was preventing the original send.
- **Fix:**
  1. Removed the pre-emptive `notifiedNewAt` write from `syncService` and `retryEmptySummaries`.
  2. The worker now performs an **atomic MongoDB claim** via `findOneAndUpdate({ _id, notifiedNewAt: null }, { $set: { notifiedNewAt: now } })`. Only the database write that succeeds proceeds to send the WhatsApp message — this is both the duplicate guard and the marker in a single atomic operation, correctly implementing exactly-once delivery.
  3. Added `String()` coercion for `post.id` and `post.updatedAt` to prevent type-mismatch bugs where numeric portal IDs fail to match string-typed database entries (making every post appear as `isNew` every sync cycle).

### 5.2 Admin Announcements Silently Discarded
- **Problem:** Portal notices that are not placement drives (e.g., "Placement Verification", "Ittlam Systems - More Details") have no company or role, so the Gemini AI correctly returns an empty summary. The old code treated these as failed extractions and silently skipped them forever. Students never received important admin announcements from the placement office.
- **Root Cause:** The `extractionFailed` guard (`!summary.company && !summary.role`) was a blanket skip for all non-placement content, with no fallback path. The `retryEmptySummaries` function also just looped indefinitely retrying AI extraction on these notices since they would never have a company extracted.
- **Fix:**
  1. Added a new `admin-announcement` BullMQ job type. When AI extraction returns empty, the notice is now queued as an admin announcement instead of being dropped.
  2. Added `formatAdminAnnouncement()` template in `templates.js` that strips HTML from `rawBody` and formats the content as a `📢 PLACEMENT OFFICE ANNOUNCEMENT` message.
  3. In `retryEmptySummaries`, when AI still returns empty after retry, the notice is queued as `admin-announcement` with a **deterministic `jobId`** (`admin-<noticeId>`) so BullMQ deduplicates across sync cycles — even if multiple cycles queue the same job, only one exists in the queue at a time.
  4. Admin announcements are sent **exactly once** (atomic worker claim) with **no deadline reminders** scheduled.
  5. Wrote a one-time migration script (`scripts/markOldNoticesNotified.js`) that: (A) marks stuck historical placement drives as already-notified so the fixed bot doesn't re-blast old posts, and (B) resets `notifiedNewAt = null` for admin notices that were pre-marked by the old bug but never actually sent, so they are delivered on the first run.

### 5.3 Chromium SingletonLock Restart Loop (Recurrence)
- **Problem:** After redeploying via `docker compose down && docker compose up -d --build`, the bot entered a crash-restart loop with the error: `The profile appears to be in use by another Chromium process`. The container never started successfully.
- **Root Cause:** When Docker stops a container abruptly, Chromium does not always clean up its `SingletonLock`, `SingletonSocket`, and `SingletonCookie` files from the persistent auth volume. The next container instance finds the stale lock files and refuses to launch, treating them as evidence of a live conflicting process.
- **Fix:**
  1. **Immediate fix:** Deleted stale lock files from the named Docker volume using: `docker run --rm -v whatbot_wa_auth_data:/data alpine sh -c "find /data -name 'Singleton*' -delete"`.
  2. **Permanent fix:** Added `--remote-debugging-port=0` and `--disable-extensions` to the Puppeteer launch arguments in `waClient.js`. The `--remote-debugging-port=0` flag prevents Chromium from registering a singleton port, which is the mechanism that triggers the lock conflict on restart.

### 5.4 Multi-Company Schedule Extraction Bug
- **Problem:** When the placement portal published a single table containing a schedule for *multiple* companies (e.g., Tarana, Addepar, Opengov, TCS), the bot only sent a WhatsApp notification for the *first* company in the table and completely ignored the rest.
- **Root Cause:** The `SUMMARY_SCHEMA` used for Gemini AI extraction enforced exactly one `company` and one `role` string per notice. Confronted with a table of multiple companies, the AI simply extracted the first row that matched the schema and discarded the remaining rows to adhere to the strict JSON constraints.
- **Fix:** Instead of redesigning the entire database schema to support arrays of opportunities, the AI prompt in `aiSummaryService.js` was updated to perform *aggregation*. 
  - The schema descriptions for `company` and `role` were modified to instruct the AI to combine multiple entities with commas (e.g., `Company: Tarana, Addepar, TCS`).
  - An explicit instruction was added to `buildPrompt`: "If the notice is a schedule containing multiple companies, COMBINE their names in the 'company' field... and summarize the different dates and criteria in 'importantInstructions'." 
  - This effectively condenses the entire table into a single, comprehensive WhatsApp message.


## 6. Notification & Sync Bugs (Jul 14, 2026)

### 6.1 `notice-updated` Duplicate Sends on BullMQ Retry
- **Problem:** When a portal notice was genuinely updated (e.g., Opengov eligible batches changed), the "PLACEMENT NOTICE UPDATED" WhatsApp message was sent **multiple times** — seen as two identical messages 10 minutes apart in the group.
- **Root Cause:** Two compounding bugs:
  1. **Worker layer:** The old `notice-updated` job wrote `notifiedUpdateAt` to MongoDB **after** calling `sendToGroup`. If anything failed between the send and the DB write (network blip, container restart), BullMQ retried the job and found `notifiedUpdateAt = null` — so it sent the message again.
  2. **Sync layer:** The sync service had **no guard on `notifiedUpdateAt`** before queuing a new `notice-updated` job. If the portal's relative timestamp string changed between sync cycles (`"23 hours ago"` → `"1 day ago"`), `isChanged = true` was triggered again, a new job was queued, and the message fired a second time.
- **Fix:**
  1. The worker now performs an **atomic MongoDB claim before sending**: `findOneAndUpdate({ notifiedUpdateAt: null OR notifiedUpdateAt < lastSyncedAt })`. The DB is written first; the send happens after. Retries for the same event are blocked; future genuine updates are allowed (because a new content change produces a newer `lastSyncedAt`).
  2. A **deterministic `jobId`** (`update-<noticeId>-<lastSyncedAt.getTime()>`) is added in `syncService` when queuing `notice-updated`. BullMQ drops duplicate enqueues for the same change event while the job is still in the queue.

### 6.2 Wasted Gemini API Calls Every Sync Cycle for Admin Notices
- **Problem:** The Gemini API was being called repeatedly (every 5 minutes) for office/admin notices (e.g., "Placement Verification", "Report to Address") that have no company or role, even though the website had not changed at all.
- **Root Cause:** `retryEmptySummaries()` runs at the end of every sync cycle and queries for all notices with `summary.company = ''` and `notifiedNewAt = null`. Admin notices (which will never have a company extracted) match this query indefinitely. There was nothing to stop Gemini from being called on them again and again while their BullMQ `admin-announcement` job was still waiting to be processed by the worker.
- **Fix:**
  1. Added a `pendingAdminAt` timestamp field to the `Notice` schema.
  2. When an `admin-announcement` job is queued (in both the main sync loop and `retryEmptySummaries`), `pendingAdminAt` is written to the DB **before** adding the job to BullMQ.
  3. `retryEmptySummaries` now filters `pendingAdminAt: null` — so any notice already queued as admin is completely skipped, eliminating the unnecessary Gemini call every cycle.
  4. A deterministic `jobId: admin-<noticeId>` was also added to the main sync loop (it was already present in `retryEmptySummaries` but missing in the main loop), ensuring BullMQ deduplicates any race between the two code paths.

### 6.3 Portal Relative Timestamp Drift Causing Unnecessary API Calls
- **Problem:** The college placement portal returns `updatedAt` as a **relative string** (e.g., `"1 day ago"`, `"35 minutes ago"`) instead of an absolute timestamp. These strings change every sync cycle — e.g., `"1 day ago"` becomes `"2 days ago"` — triggering `isChanged = true` and causing the bot to make two unnecessary portal API calls (`fetchPostDetail` + `fetchAttachments`) for every existing post on the day the string ticked over. At scale (30–50 posts), this would be 60–100 extra API calls in a single sync cycle.
- **Root Cause:** Change detection relied solely on `existing.portalUpdatedAt !== postUpdatedAt` — a string comparison of an inherently unstable relative value.
- **Fix:** Implemented a **two-phase content hash change detection** system:
  1. **Phase 1 (zero API calls):** The `portalUpdatedAt` string is still used as a fast first-pass gate. If the string hasn't changed, skip the post entirely.
  2. **Phase 2 (after fetching detail):** An MD5 hash of `title + rawBody + attachments` is computed and compared against `contentHash` stored in the DB. This is the **definitive change check** — immune to relative string drift.
  - A new `contentHash` field was added to the `Notice` schema and is saved on every write.
  - If the portal timestamp drifted but the content hash is identical → update `portalUpdatedAt` in DB and continue. No Gemini, no BullMQ job, no WhatsApp message.
  - If the hash differs → genuine content change → proceed with Gemini extraction and notification.
  - The old verbose 13-line content-identity check (comparing full body strings) was removed and replaced by the clean hash comparison.

### 6.4 Daily Digest and Deadline Reminders Firing at Wrong Time (UTC vs IST)
- **Problem:** The daily digest was being sent at **2:30 AM IST** instead of 9:00 AM. Deadline reminders were also firing in the early morning hours.
- **Root Cause:** The AWS EC2 server runs in UTC by default. The daily digest cron `0 9 * * *` means 9:00 AM UTC = **2:30 AM IST**. Similarly, `dayjs().endOf('day')` in the reminder scheduler resolved to midnight UTC = 5:30 AM IST, causing the final reminder to fire at ~3:30 AM IST.
- **Fix:** Added `TZ=Asia/Kolkata` to the bot service environment block in `docker-compose.yml`. This sets the Node.js process timezone to IST inside the container, making all `dayjs()` calls, cron expressions, and `Date` operations run in Indian Standard Time with no code changes required.


existing.contentHash === null  →  baseline guard fires → save hash, skip ✅
existing.contentHash === newHash  →  drift-only path → update timestamps, skip ✅  
existing.contentHash !== newHash  →  genuine change → run AI diff + notify ✅



the msg of update of a company are being sent as a new drive 
-->to be fixed

the data in the chat -->like tables are made the tables
and as for the plain text we provied the link
