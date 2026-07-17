'use strict';

const crypto = require('crypto');
const dayjs = require('dayjs');
const logger = require('../utils/logger').child({ module: 'syncService' });
const { downloadStorageState, extractSessionCookie } = require('../portal/sessionManager');
const { getFreshJWT, fetchPostList, fetchPostDetail, fetchAttachments } = require('../portal/portalClient');
const { extractSummary } = require('./aiSummaryService');
const { diffSummary } = require('./diffService');
const Notice = require('../models/Notice');
const { notificationQueue, reminderQueue } = require('../jobs/queue');
const { extractTableToCsvAttachment } = require('../utils/tableExtractor');

/**
 * Schedule 24h and same-day deadline reminders for a notice.
 * Uses deterministic jobIds so re-scheduling replaces old jobs automatically.
 */
async function scheduleReminders(notice) {
  if (!notice.summary?.deadline) return;

  const deadline = dayjs(notice.summary.deadline);
  const now = dayjs();
  const id = notice._id.toString();

  const jobs = [
    { name: 'deadline-reminder', when: deadline.subtract(24, 'hour'), suffix: '24h' },
    { name: 'final-reminder',    when: deadline.endOf('day').subtract(2, 'hour'), suffix: 'final' },
  ];

  for (const { name, when, suffix } of jobs) {
    if (when.isAfter(now)) {
      await reminderQueue.add(name, { noticeId: id }, {
        delay: when.diff(now),
        jobId: `reminder-${id}-${suffix}`,
        removeOnComplete: true,
        removeOnFail: 5,
      });
      logger.debug({ noticeId: id, name, when: when.toISOString() }, 'Reminder scheduled');
    }
  }
}

/**
 * Run one complete sync cycle:
 *  1. Download session from S3
 *  2. Get JWT
 *  3. Fetch post list
 *  4. For each new/changed post: fetch detail + AI summary + diff + save + enqueue jobs
 */
async function runSync() {
  logger.info('── Sync cycle started ──');

  // Session
  await downloadStorageState();
  const cookie = extractSessionCookie();
  if (!cookie) throw new Error('No session cookie — run npm run login first');

  const jwt = await getFreshJWT(cookie); // throws SESSION_EXPIRED on 401

  const posts = await fetchPostList(jwt);
  logger.info({ count: posts.length }, 'Post list fetched');

  let newCount = 0;
  let updatedCount = 0;

  for (const post of posts) {
    // Coerce to string to prevent type-mismatch if the portal returns numeric IDs.
    const postId = String(post.id);
    const postUpdatedAt = String(post.updatedAt || '');

    const existing = await Notice.findOne({ portalPostId: postId }).lean();

    const isNew = !existing;
    // First-pass gate: use the portal's updatedAt string to skip posts that haven't
    // even ticked their relative timestamp. This avoids fetchPostDetail for the majority
    // of posts on every cycle. The definitive isChanged check comes AFTER fetching,
    // using a content hash that's immune to relative string drift.
    const portalTimestampChanged = existing && existing.portalUpdatedAt !== postUpdatedAt;

    if (!isNew && !portalTimestampChanged) continue;

    logger.info({ postId, title: post.title, isNew, portalTimestampChanged }, 'Processing post');

    const [detail, rawAttachments] = await Promise.all([
      fetchPostDetail(jwt, postId),
      fetchAttachments(jwt, postId),
    ]);

    const newRawBody = detail.body || detail.title || '';
    const newAttachments = rawAttachments.map((a) => {
      let url = a.url;
      if (!url && a.s3Key) {
        const match = a.s3Key.match(/^s3:\/\/([^\/]+)\/(.+)$/);
        if (match) {
          url = `https://${match[1]}.s3.amazonaws.com/${match[2]}`;
        }
      }
      return { fileName: a.originalFileName || a.fileName, url };
    });

    const tableAttachment = extractTableToCsvAttachment(newRawBody);
    if (tableAttachment) {
      newAttachments.push(tableAttachment);
    }

    // Compute content hash — the definitive source of truth for change detection.
    // Compares title + body + attachments so that a portal relative-timestamp tick
    // ("1 day ago" → "2 days ago") is NOT treated as a content change.
    const newContentHash = crypto
      .createHash('md5')
      .update(post.title + newRawBody + JSON.stringify(newAttachments))
      .digest('hex');

    // Baseline guard: existing record has no contentHash yet (saved before the
    // hash feature was deployed). null !== newHash is truthy, which would
    // incorrectly set isChanged = true and enqueue a notice-updated job for a
    // post that was never actually modified. Instead, silently save the hash as
    // the baseline and skip — identical to the drift-only path below.
    if (existing && existing.contentHash === null) {
      logger.info({ postId, title: post.title }, 'Establishing content hash baseline for pre-feature record — not a change.');
      await Notice.updateOne(
        { portalPostId: postId },
        { $set: { contentHash: newContentHash, portalUpdatedAt: postUpdatedAt, lastSyncedAt: new Date() } }
      );
      continue;
    }

    const isChanged = existing && existing.contentHash !== newContentHash;

    if (!isNew && !isChanged) {
      // portalUpdatedAt string drifted but content is identical — just update the
      // stored timestamp so the next cycle's first-pass gate matches again.
      logger.info({ postId, title: post.title }, 'Portal timestamp drifted but content hash unchanged — skipping LLM diff.');
      await Notice.updateOne(
        { portalPostId: postId },
        { $set: { portalUpdatedAt: postUpdatedAt, lastSyncedAt: new Date() } }
      );
      continue;
    }

    const attachments = newAttachments; // for the rest of the code
    const summary = await extractSummary(post.title, newRawBody);

    // If AI extraction failed (rate limit exhausted after retries), skip notification.
    // The notice is still saved so the portal updatedAt is tracked.
    // It will be re-processed properly when the portal next updates the post.
    const extractionFailed = !summary.company && !summary.role;
    if (extractionFailed) {
      logger.warn({ postId, title: post.title }, 'AI extraction returned empty — saving to DB but skipping notification');
    }

    // Diff against stored summary.
    // If the previous summary was also empty (prior failed extraction), treat as new-drive
    // so we don't produce a confusing diff full of "— → Microsoft" lines.
    const prevSummaryWasEmpty = existing?.summary && !existing.summary.company && !existing.summary.role;
    let diff = { hasChanges: false, lines: [] };
    if (isChanged && existing?.summary && !prevSummaryWasEmpty) {
      diff = diffSummary(existing.summary, summary);
    }

    const notice = await Notice.findOneAndUpdate(
      { portalPostId: postId },
      {
        $set: {
          portalPostId: postId,
          title: post.title,
          rawBody: newRawBody,
          attachments: attachments,
          contentHash: newContentHash,
          summary,
          previousSummary: isChanged ? existing.summary : undefined,
          portalCreatedAt: post.createdAt || '',
          portalUpdatedAt: postUpdatedAt,
          lastSyncedAt: new Date(),
        },
      },
      { upsert: true, returnDocument: 'after' }
    );

    const noticeId = notice._id.toString();

    if (extractionFailed) {
      // No company/role found — treat as an admin/office announcement.
      // Send it once (no reminders). The worker uses an atomic claim so it's sent exactly once
      // even if the job is retried.
      // Guard: skip if already sent OR already queued (pendingAdminAt prevents re-queuing
      // in subsequent sync cycles while the job is still waiting in the BullMQ queue).
      if (!notice.notifiedNewAt && !notice.pendingAdminAt) {
        logger.info({ postId, title: post.title }, 'Queuing as admin-announcement (no company extracted)');
        // Set pendingAdminAt BEFORE queuing so the next sync cycle skips this notice.
        await Notice.findByIdAndUpdate(noticeId, { $set: { pendingAdminAt: new Date() } });
        await notificationQueue.add('admin-announcement', { noticeId }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          jobId: `admin-${noticeId}`,  // deterministic — BullMQ deduplicates while job is live
          removeOnComplete: true,
          removeOnFail: 10,
        });
      }
      continue;
    }

    if (isNew || (isChanged && prevSummaryWasEmpty && !notice.notifiedNewAt)) {
      if (summary.isFollowUp) {
        // New post but it's a follow-up to an existing drive (e.g. shortlist, interview
        // schedule). Use the PLACEMENT UPDATE template instead of NEW PLACEMENT DRIVE.
        // No deadline reminders needed — these posts don't have apply deadlines.
        await notificationQueue.add('follow-up-post', { noticeId }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: 10,
        });
        logger.info({ noticeId, company: summary.company }, 'Queued as follow-up-post');
        newCount++;
      } else {
        // Genuine new placement/internship drive.
        // NOTE: Do NOT set notifiedNewAt here. The worker atomically claims the send
        // using findOneAndUpdate({ notifiedNewAt: null }) so it acts as both the guard
        // and the marker. This avoids the race where a pre-emptive write causes the
        // worker to see notifiedNewAt already set and skip the actual send.
        await notificationQueue.add('new-drive', { noticeId }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: 10,
        });
        await scheduleReminders(notice);
        newCount++;
      }
    } else if (isChanged && diff.hasChanges) {
      // Deterministic jobId: ties this job to the exact change event (lastSyncedAt).
      // If the sync cycle detects the same change again before this job is processed,
      // BullMQ sees the same jobId and discards the duplicate enqueue.
      const updateJobId = `update-${noticeId}-${notice.lastSyncedAt.getTime()}`;
      await notificationQueue.add('notice-updated', { noticeId, diffLines: diff.lines }, {
        jobId: updateJobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 10,
      });
      await scheduleReminders(notice);
      updatedCount++;
    }
  }

  logger.info({ newCount, updatedCount }, '── Sync cycle complete ──');

  // Retry any notices that have empty summaries from previous failed AI extractions
  const retried = await retryEmptySummaries();
  return { newCount, updatedCount, retriedEmpty: retried };
}

/**
 * Find notices with empty AI summaries (previous extraction failed due to rate limit)
 * and re-run extraction using the already-stored rawBody.
 * Called at the end of every sync cycle — no portal fetch needed.
 */
async function retryEmptySummaries() {
  const empties = await Notice.find({
    'summary.company': '',
    'summary.role': '',
    notifiedNewAt: null,
    pendingAdminAt: null,  // skip notices already queued as admin-announcement
    rawBody: { $exists: true, $ne: '' },
  }).lean();

  if (empties.length === 0) return 0;

  logger.info({ count: empties.length }, 'Retrying AI extraction for notices with empty summaries...');

  let recovered = 0;
  for (const existing of empties) {
    const summary = await extractSummary(existing.title, existing.rawBody);

    if (!summary.company && !summary.role) {
      // AI still can't extract company/role — this is an admin/office announcement,
      // not a placement drive. Queue it as admin-announcement (sent once, no reminders).
      // Set pendingAdminAt so future retryEmptySummaries cycles skip this notice
      // entirely (no Gemini call) until the worker processes it and sets notifiedNewAt.
      const noticeId = existing._id.toString();
      logger.info({ postId: existing.portalPostId, title: existing.title }, 'Empty after retry — queuing as admin-announcement');
      // Set pendingAdminAt BEFORE queuing to protect against the next sync cycle.
      await Notice.findByIdAndUpdate(existing._id, { $set: { pendingAdminAt: new Date() } });
      await notificationQueue.add('admin-announcement', { noticeId }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        jobId: `admin-${noticeId}`,   // deduplicates in BullMQ queue
        removeOnComplete: true,
        removeOnFail: 10,
      });
      continue;
    }

    // Save the recovered summary (do NOT set notifiedNewAt here — the worker
    // atomically claims the send to avoid pre-emptive writes blocking the notification).
    const notice = await Notice.findByIdAndUpdate(
      existing._id,
      { $set: { summary, lastSyncedAt: new Date() } },
      { returnDocument: 'after' }
    );

    // Enqueue the new-drive notification; worker will set notifiedNewAt atomically.
    await notificationQueue.add('new-drive', { noticeId: notice._id.toString() }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: 10,
    });
    await scheduleReminders(notice);

    logger.info({ postId: existing.portalPostId, company: summary.company }, 'Empty summary recovered — notification queued');
    recovered++;
  }

  if (recovered > 0) {
    logger.info({ recovered }, 'Empty summary recovery complete');
  }

  return recovered;
}

module.exports = { runSync };
