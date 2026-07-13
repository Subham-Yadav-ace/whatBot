'use strict';

const dayjs = require('dayjs');
const logger = require('../utils/logger').child({ module: 'syncService' });
const { downloadStorageState, extractSessionCookie } = require('../portal/sessionManager');
const { getFreshJWT, fetchPostList, fetchPostDetail, fetchAttachments } = require('../portal/portalClient');
const { extractSummary } = require('./aiSummaryService');
const { diffSummary } = require('./diffService');
const Notice = require('../models/Notice');
const { notificationQueue, reminderQueue } = require('../jobs/queue');

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

    const isNew     = !existing;
    const isChanged = existing && existing.portalUpdatedAt !== postUpdatedAt;

    if (!isNew && !isChanged) continue;

    logger.info({ postId, title: post.title, isNew, isChanged }, 'Processing post');

    const [detail, attachments] = await Promise.all([
      fetchPostDetail(jwt, postId),
      fetchAttachments(jwt, postId),
    ]);

    const summary = await extractSummary(post.title, detail.body || detail.title || '');

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
          rawBody: detail.body || '',
          attachments: attachments.map((a) => ({ fileName: a.fileName, url: a.url })),
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

    // Don't send any notification if AI extraction returned empty data.
    // Students won't get a useless "Company: —" message.
    if (extractionFailed) continue;

    if (isNew || (isChanged && prevSummaryWasEmpty && !notice.notifiedNewAt)) {
      // New post OR previously failed extraction now succeeded — send full new-drive message.
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
    } else if (isChanged && diff.hasChanges) {
      await notificationQueue.add('notice-updated', { noticeId, diffLines: diff.lines }, {
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
    rawBody: { $exists: true, $ne: '' },
  }).lean();

  if (empties.length === 0) return 0;

  logger.info({ count: empties.length }, 'Retrying AI extraction for notices with empty summaries...');

  let recovered = 0;
  for (const existing of empties) {
    const summary = await extractSummary(existing.title, existing.rawBody);

    if (!summary.company && !summary.role) {
      logger.warn({ postId: existing.portalPostId }, 'Retry still returned empty summary — will try again next cycle');
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
