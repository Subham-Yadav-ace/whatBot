'use strict';

const { Worker } = require('bullmq');
const { createRedisConnection } = require('../config/redis');
const Notice = require('../models/Notice');
const { sendToGroup } = require('../whatsapp/waClient');
const { formatDeadlineReminder, formatFinalReminder } = require('../whatsapp/templates');
const env = require('../config/env');
const logger = require('../utils/logger').child({ module: 'reminderWorker' });

async function startReminderWorker() {
  const worker = new Worker(
    'reminder',
    async (job) => {
      const { noticeId } = job.data;

      const notice = await Notice.findById(noticeId);
      if (!notice) {
        logger.warn({ noticeId }, 'Notice not found for reminder — skipping');
        return;
      }

      if (job.name === 'deadline-reminder') {
        await sendToGroup(formatDeadlineReminder(notice));
        logger.info({ noticeId, company: notice.summary.company }, '24h deadline reminder sent');
        return;
      }

      if (job.name === 'final-reminder') {
        await sendToGroup(formatFinalReminder(notice));
        logger.info({ noticeId, company: notice.summary.company }, 'Final reminder sent');
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
      limiter: { max: 1, duration: env.whatsappSendDelayMs },
    }
  );

  worker.on('completed', (job) =>
    logger.info({ jobId: job.id, name: job.name }, 'Reminder job done')
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, name: job?.name, err: err.message }, 'Reminder job failed')
  );

  return worker;
}

module.exports = { startReminderWorker };
