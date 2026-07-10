'use strict';

const { Queue } = require('bullmq');
const { getRedisConnection } = require('../config/redis');
const logger = require('../utils/logger').child({ module: 'queue' });

const connection = getRedisConnection();

const syncQueue         = new Queue('sync',         { connection });
const notificationQueue = new Queue('notification', { connection });
const reminderQueue     = new Queue('reminder',     { connection });
const digestQueue       = new Queue('digest',       { connection });

logger.info('BullMQ queues initialized (sync, notification, reminder, digest)');

module.exports = { syncQueue, notificationQueue, reminderQueue, digestQueue };
