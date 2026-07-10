'use strict';

const { Worker } = require('bullmq');
const dayjs = require('dayjs');
const { createRedisConnection } = require('../config/redis');
const { digestQueue } = require('./queue');
const Notice = require('../models/Notice');
const { sendToGroup } = require('../whatsapp/waClient');
const { formatDailyDigest } = require('../whatsapp/templates');
const env = require('../config/env');
const logger = require('../utils/logger').child({ module: 'digestWorker' });

async function startDigestWorker() {
  // Register cron (idempotent)
  await digestQueue.add(
    'daily-digest',
    {},
    {
      repeat: { pattern: env.dailyDigestCron },
      jobId: 'daily-digest-cron',
    }
  );
  logger.info({ cron: env.dailyDigestCron }, 'Daily digest cron registered');

  const worker = new Worker(
    'digest',
    async (job) => {
      logger.info({ jobId: job.id }, 'Running daily digest');

      const todayStart = dayjs().startOf('day').toDate();
      const in3Days    = dayjs().add(3, 'day').endOf('day').toDate();

      const [newDrives, upcomingDeadlines] = await Promise.all([
        Notice.find({ createdAt: { $gte: todayStart } })
          .sort({ portalCreatedAt: -1 })
          .limit(20),
        Notice.find({ 'summary.deadline': { $gte: new Date(), $lte: in3Days } })
          .sort({ 'summary.deadline': 1 })
          .limit(10),
      ]);

      if (newDrives.length === 0 && upcomingDeadlines.length === 0) {
        logger.info('Nothing to digest today — skipping send');
        return;
      }

      await sendToGroup(formatDailyDigest(newDrives, upcomingDeadlines));
      logger.info({ newDrives: newDrives.length, deadlines: upcomingDeadlines.length }, 'Daily digest sent');
    },
    { connection: createRedisConnection(), concurrency: 1 }
  );

  worker.on('completed', (job) => logger.info({ jobId: job.id }, 'Digest job done'));
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err: err.message }, 'Digest job failed')
  );

  return worker;
}

module.exports = { startDigestWorker };
