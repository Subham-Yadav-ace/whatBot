'use strict';

/**
 * One-time migration script.
 *
 * The old syncService had a bug: it set notifiedNewAt BEFORE enqueuing the job,
 * which caused the worker to see it already set and skip the actual send.
 * As a result, many notices in the DB have notifiedNewAt=null even though
 * they were processed before the fix.
 *
 * This script marks all such notices as notified so the fixed bot doesn't
 * re-blast old/historical notices on its first run.
 *
 * Run ONCE on EC2 after pulling the fix, before restarting the bot:
 *   node scripts/markOldNoticesNotified.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Notice = require('../src/models/Notice');

const MONGO_URI = process.env.MONGO_URI;

async function main() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('Connected.');

  // Find all notices with a valid company name but no notifiedNewAt timestamp.
  // These are "stuck" notices that were processed but never sent due to the bug.
  const stuck = await Notice.find({
    notifiedNewAt: null,
    'summary.company': { $ne: '' },
  }).select('_id title summary.company portalCreatedAt').lean();

  if (stuck.length === 0) {
    console.log('No stuck notices found. Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  console.log(`\nFound ${stuck.length} stuck notice(s) to mark as notified:`);
  stuck.forEach((n) =>
    console.log(`  - [${n._id}] ${n['summary.company'] || '?'} | ${n.title}`)
  );

  const now = new Date();
  const result = await Notice.updateMany(
    {
      notifiedNewAt: null,
      'summary.company': { $ne: '' },
    },
    { $set: { notifiedNewAt: now } }
  );

  console.log(`\n✅ Marked ${result.modifiedCount} notice(s) as notifiedNewAt=${now.toISOString()}`);
  console.log('The fixed bot will only send notifications for NEW notices going forward.');

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
