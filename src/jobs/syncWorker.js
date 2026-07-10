'use strict';

const { Worker } = require('bullmq');
const { createRedisConnection } = require('../config/redis');
const { syncQueue } = require('./queue');
const { runSync } = require('../services/syncService');
const env = require('../config/env');
const logger = require('../utils/logger').child({ module: 'syncWorker' });

async function startSyncWorker() {
  // Register the single repeatable job (idempotent — safe to call on every startup)
  await syncQueue.add(
    'sync-portal',
    {},
    {
      repeat: { every: env.syncIntervalMs },
      jobId: 'sync-portal-repeatable',
    }
  );
  logger.info({ intervalMs: env.syncIntervalMs }, 'Sync repeatable job registered');

  const worker = new Worker(
    'sync',
    async (job) => {
      logger.info({ jobId: job.id }, 'Sync job started');
      return runSync();
    },
    {
      connection: createRedisConnection(),
      concurrency: 1, // never run two syncs in parallel
    }
  );

  worker.on('completed', (job, result) => {
    logger.info({ jobId: job.id, ...result }, 'Sync job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'Sync job failed');
  });

  return worker;
}

module.exports = { startSyncWorker };
