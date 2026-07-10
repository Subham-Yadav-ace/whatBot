'use strict';

require('dotenv').config();

const env    = require('./config/env');
const logger = require('./utils/logger').child({ module: 'main' });
const { connectDB, disconnectDB }       = require('./config/db');
const { initWAClient, destroyClient }   = require('./whatsapp/waClient');
const { startSyncWorker }               = require('./jobs/syncWorker');
const { startNotificationWorker }       = require('./jobs/notificationWorker');
const { startReminderWorker }           = require('./jobs/reminderWorker');
const { startDigestWorker }             = require('./jobs/digestWorker');

let workers = [];

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down gracefully...');
  await Promise.allSettled(workers.map((w) => w.close()));
  await destroyClient();
  await disconnectDB();
  logger.info('Shutdown complete');
  process.exit(0);
}

async function main() {
  logger.info('🤖 AIT Placement Bot starting up...');

  logger.info('Step 1/3: Connecting to MongoDB...');
  await connectDB(env.mongoUri);

  logger.info('Step 2/3: Initializing WhatsApp (scan QR if prompted)...');
  await initWAClient();

  logger.info('Step 3/3: Starting BullMQ workers...');
  const syncWorker    = await startSyncWorker();
  const notifWorker   = await startNotificationWorker();
  const remindWorker  = await startReminderWorker();
  const digestWorker  = await startDigestWorker();
  workers = [syncWorker, notifWorker, remindWorker, digestWorker];

  logger.info('🚀 AIT Placement Bot is live! Syncing every ' + env.syncIntervalMs / 1000 + 's');

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch(async (err) => {
  logger.error({ err: err.message, stack: err.stack }, 'Fatal startup error — exiting');
  await disconnectDB().catch(() => {});
  process.exit(1);
});
