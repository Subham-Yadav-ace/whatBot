'use strict';

/**
 * One-time migration script — run ONCE on EC2 before restarting after the fix.
 *
 *   node scripts/markOldNoticesNotified.js
 *
 * What it does:
 *
 * Part A — Placement drives with valid company names that were never sent
 *   (notifiedNewAt=null). Mark them as notified so the bot doesn't re-blast
 *   every historical drive on its first run.
 *
 * Part B — Admin announcements (empty company) that were incorrectly pre-marked
 *   as notifiedNewAt by the old buggy syncService but never actually sent.
 *   Reset their notifiedNewAt=null so the fixed bot will send them once.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Notice = require('../src/models/Notice');

const MONGO_URI = process.env.MONGO_URI;

async function main() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('Connected.\n');

  // ── Part A: Mark stuck placement drives as already notified ──────────────
  const stuckDrives = await Notice.find({
    notifiedNewAt: null,
    'summary.company': { $ne: '' },
  }).select('_id title summary.company').lean();

  if (stuckDrives.length > 0) {
    console.log(`Part A — Found ${stuckDrives.length} stuck placement drive(s) to silence:`);
    stuckDrives.forEach((n) =>
      console.log(`  - ${n.summary?.company || '?'} | ${n.title}`)
    );
    const now = new Date();
    const r = await Notice.updateMany(
      { notifiedNewAt: null, 'summary.company': { $ne: '' } },
      { $set: { notifiedNewAt: now } }
    );
    console.log(`  ✅ Marked ${r.modifiedCount} notice(s) as notified (won't be re-sent)\n`);
  } else {
    console.log('Part A — No stuck placement drives found.\n');
  }

  // ── Part B: Unblock admin announcements that were never sent ─────────────
  // These have notifiedNewAt SET (pre-set by old bug) but company is empty,
  // meaning the message was never actually delivered. Reset so bot sends them.
  const blockedAnnouncements = await Notice.find({
    notifiedNewAt: { $ne: null },
    'summary.company': '',
    'summary.role': '',
    rawBody: { $exists: true, $ne: '' },
  }).select('_id title').lean();

  if (blockedAnnouncements.length > 0) {
    console.log(`Part B — Found ${blockedAnnouncements.length} blocked admin announcement(s) to unblock:`);
    blockedAnnouncements.forEach((n) =>
      console.log(`  - ${n.title}`)
    );
    const r = await Notice.updateMany(
      {
        notifiedNewAt: { $ne: null },
        'summary.company': '',
        'summary.role': '',
        rawBody: { $exists: true, $ne: '' },
      },
      { $set: { notifiedNewAt: null } }
    );
    console.log(`  ✅ Reset ${r.modifiedCount} announcement(s) — bot will send them once on next sync\n`);
  } else {
    console.log('Part B — No blocked admin announcements found.\n');
  }

  await mongoose.disconnect();
  console.log('Migration complete. You can now restart the bot.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
