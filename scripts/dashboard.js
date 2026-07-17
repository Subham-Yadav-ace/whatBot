'use strict';

const express = require('express');
const { Queue } = require('bullmq');
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const { getRedisConnection } = require('../src/config/redis');

// Initialize Redis connection
const connection = getRedisConnection();

// Initialize all your queues
const syncQ = new Queue('sync', { connection });
const notifQ = new Queue('notification', { connection });
const reminderQ = new Queue('reminder', { connection });
const digestQ = new Queue('digest', { connection });

// Set up the Bull-Board server adapter
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

// Register the queues with Bull-Board
createBullBoard({
  queues: [
    new BullMQAdapter(syncQ),
    new BullMQAdapter(notifQ),
    new BullMQAdapter(reminderQ),
    new BullMQAdapter(digestQ)
  ],
  serverAdapter: serverAdapter,
});

// Create Express app and route
const app = express();
app.use('/admin/queues', serverAdapter.getRouter());

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Bull-Board UI is running on http://localhost:${PORT}/admin/queues`);
});
