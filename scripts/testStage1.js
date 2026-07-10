#!/usr/bin/env node
'use strict';

/**
 * scripts/testStage1.js
 *
 * Stage 1 end-to-end smoke test.
 * Verifies: portal auth → post list → post detail → attachments → AI extraction → MongoDB save
 *
 * Usage:
 *   npm run test:stage1
 *
 * Prerequisites:
 *   - .env file filled in
 *   - MongoDB + Redis running (docker compose up -d)
 *   - storageState.json on S3 (run npm run login first) OR locally in project root
 */

require('dotenv').config();

const env = require('../src/config/env');
const { connectDB, disconnectDB } = require('../src/config/db');
const { downloadStorageState, extractSessionCookie } = require('../src/portal/sessionManager');
const { getFreshJWT, fetchPostList, fetchPostDetail, fetchAttachments } = require('../src/portal/portalClient');
const { extractSummary } = require('../src/services/aiSummaryService');
const Notice = require('../src/models/Notice');
const fs = require('fs');
const path = require('path');

const log = (msg, data) => {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${msg}`, data !== undefined ? JSON.stringify(data, null, 2) : '');
};

async function run() {
  console.log('\n===========================================');
  console.log('  Stage 1 Smoke Test — AIT Placement Bot');
  console.log('===========================================\n');

  // ── Step 1: Connect to MongoDB ──────────────────────────────────────────
  log('STEP 1: Connecting to MongoDB...');
  await connectDB(env.mongoUri);
  log('✅ MongoDB connected\n');

  // ── Step 2: Get session cookie ───────────────────────────────────────────
  log('STEP 2: Getting session cookie...');

  const localPath = path.resolve(process.cwd(), 'storageState.json');
  let cookieValue;

  if (fs.existsSync(localPath)) {
    log('  Found local storageState.json — using it directly');
    cookieValue = extractSessionCookie(localPath);
  } else {
    log('  No local storageState.json — downloading from S3...');
    await downloadStorageState();
    cookieValue = extractSessionCookie(localPath);
  }

  if (!cookieValue) {
    throw new Error('Could not extract session cookie. Run "npm run login" first.');
  }
  log('✅ Session cookie extracted\n');

  // ── Step 3: Fetch fresh JWT ──────────────────────────────────────────────
  log('STEP 3: Fetching JWT from portal...');
  const jwt = await getFreshJWT(cookieValue);
  log('✅ JWT fetched:', { preview: jwt.substring(0, 40) + '...' });
  console.log();

  // ── Step 4: Fetch post list ──────────────────────────────────────────────
  log('STEP 4: Fetching placement post list...');
  const posts = await fetchPostList(jwt);
  log(`✅ ${posts.length} posts found`);

  if (posts.length === 0) {
    log('⚠️  No posts found. The portal may have no notices yet. Skipping further steps.');
    await disconnectDB();
    process.exit(0);
  }

  // Preview first 3 posts
  log('  Preview (first 3):');
  posts.slice(0, 3).forEach((p, i) => {
    log(`    [${i + 1}] ${p.id} — ${p.title} (updated: ${p.updatedAt})`);
  });
  console.log();

  // ── Step 5: Fetch detail + attachments for first post ───────────────────
  const testPost = posts[0];
  log(`STEP 5: Fetching detail for post "${testPost.title}" (id: ${testPost.id})...`);
  const detail = await fetchPostDetail(jwt, testPost.id);
  log('✅ Post detail fetched');
  log('  Body preview (first 300 chars):', (detail.body || '').substring(0, 300));
  console.log();

  log('  Fetching attachments...');
  const attachments = await fetchAttachments(jwt, testPost.id);
  log(`✅ ${attachments.length} attachment(s):`);
  attachments.forEach((a) => log(`    - ${a.fileName}: ${a.url}`));
  console.log();

  // ── Step 6: AI Extraction ────────────────────────────────────────────────
  log('STEP 6: Running Gemini AI extraction...');
  const summary = await extractSummary(testPost.title, detail.body || detail.title || '');
  log('✅ AI extraction result:');
  console.log(JSON.stringify(summary, null, 2));
  console.log();

  // ── Step 7: Save to MongoDB ──────────────────────────────────────────────
  log('STEP 7: Saving Notice to MongoDB...');
  const notice = await Notice.findOneAndUpdate(
    { portalPostId: testPost.id },
    {
      $set: {
        portalPostId: testPost.id,
        title: testPost.title,
        rawBody: detail.body || '',
        attachments: attachments.map((a) => ({ fileName: a.fileName, url: a.url })),
        summary,
        portalCreatedAt: testPost.createdAt || '',
        portalUpdatedAt: testPost.updatedAt || '',
        lastSyncedAt: new Date(),
      },
    },
    { upsert: true, new: true }
  );
  log('✅ Notice saved to MongoDB:', { id: notice._id.toString(), company: notice.summary.company });

  // ── Done ─────────────────────────────────────────────────────────────────
  console.log('\n===========================================');
  console.log('  ✅ Stage 1 Smoke Test PASSED');
  console.log('===========================================\n');

  await disconnectDB();
  process.exit(0);
}

run().catch((err) => {
  console.error('\n❌ Stage 1 Smoke Test FAILED:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
