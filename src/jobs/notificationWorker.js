'use strict';

const { Worker } = require('bullmq');
const { createRedisConnection } = require('../config/redis');
const Notice = require('../models/Notice');
const { sendToGroup } = require('../whatsapp/waClient');
const { formatNewDrive, formatNoticeUpdated } = require('../whatsapp/templates');
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
        await sendToGroup(formatNoticeUpdated(notice, diffLines || []));
        await Notice.findByIdAndUpdate(noticeId, { notifiedUpdateAt: new Date() }, { returnDocument: 'after' });
        logger.info({ noticeId, company: notice.summary.company }, 'Notice-updated notification sent');
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
