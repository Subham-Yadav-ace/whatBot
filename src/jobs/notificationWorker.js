'use strict';

const { Worker } = require('bullmq');
const { createRedisConnection } = require('../config/redis');
const Notice = require('../models/Notice');
const { sendToGroup } = require('../whatsapp/waClient');
const { formatNewDrive, formatNoticeUpdated, formatAdminAnnouncement } = require('../whatsapp/templates');
const env = require('../config/env');
const logger = require('../utils/logger').child({ module: 'notificationWorker' });

async function startNotificationWorker() {
  const worker = new Worker(
    'notification',
    async (job) => {
      const { noticeId, diffLines } = job.data;

      const notice = await Notice.findById(noticeId);
      if (!notice) {
        logger.warn({ noticeId }, 'Notice not found — skipping');
        return;
      }

      if (job.name === 'new-drive') {
        // Guard: don't send if AI extraction previously failed (empty company)
        if (!notice.summary?.company && !notice.summary?.role) {
          logger.warn({ noticeId }, 'new-drive job skipped — notice has empty summary (AI extraction failed earlier)');
          return;
        }
        // Atomic claim: only the first execution wins. If notifiedNewAt was already set
        // (by a previous successful run of this job), claimed will be null and we skip.
        const claimed = await Notice.findOneAndUpdate(
          { _id: noticeId, notifiedNewAt: null },
          { $set: { notifiedNewAt: new Date() } },
          { returnDocument: 'after' }
        );
        if (!claimed) {
          logger.info({ noticeId }, 'Already notified for new-drive — skipping duplicate');
          return;
        }
        await sendToGroup(formatNewDrive(notice));
        logger.info({ noticeId, company: notice.summary.company }, 'New-drive notification sent');
        return;
      }

      if (job.name === 'notice-updated') {
        // Atomic guard — prevents duplicate sends on BullMQ retry while still allowing
        // future genuine updates to the same notice.
        //
        // We use notice.lastSyncedAt as the change-event identifier:
        //   • notifiedUpdateAt: null  → never notified for an update yet → send
        //   • notifiedUpdateAt < lastSyncedAt → already notified, but syncService detected
        //     a NEW content change since then → send again (legitimate 2nd update)
        //   • notifiedUpdateAt >= lastSyncedAt → already notified for this exact change → skip
        //
        // DB is written BEFORE sendToGroup so any crash/retry between the two is safe.
        const claimed = await Notice.findOneAndUpdate(
          {
            _id: noticeId,
            $or: [
              { notifiedUpdateAt: null },
              { notifiedUpdateAt: { $lt: notice.lastSyncedAt } },
            ],
          },
          { $set: { notifiedUpdateAt: new Date() } },
          { returnDocument: 'after' }
        );
        if (!claimed) {
          logger.info({ noticeId }, 'Already notified for this update event — skipping duplicate');
          return;
        }
        await sendToGroup(formatNoticeUpdated(notice, diffLines || []));
        logger.info({ noticeId, company: notice.summary.company }, 'Notice-updated notification sent');
        return;
      }

      if (job.name === 'admin-announcement') {
        // Atomic claim — send exactly once, no reminders.
        const claimed = await Notice.findOneAndUpdate(
          { _id: noticeId, notifiedNewAt: null },
          { $set: { notifiedNewAt: new Date() } },
          { returnDocument: 'after' }
        );
        if (!claimed) {
          logger.info({ noticeId }, 'Already notified for admin-announcement — skipping duplicate');
          return;
        }
        await sendToGroup(formatAdminAnnouncement(notice));
        logger.info({ noticeId, title: notice.title }, 'Admin announcement sent');
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
      limiter: { max: 1, duration: env.whatsappSendDelayMs },
    }
  );

  worker.on('completed', (job) =>
    logger.info({ jobId: job.id, name: job.name }, 'Notification job done')
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, name: job?.name, err: err.message }, 'Notification job failed')
  );

  return worker;
}

module.exports = { startNotificationWorker };
