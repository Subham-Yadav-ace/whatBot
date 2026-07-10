#!/usr/bin/env node
'use strict';

/**
 * scripts/testStage2.js
 *
 * Stage 2 smoke test — validates the full pipeline WITHOUT BullMQ workers:
 *   portal sync → AI summary → diff → MongoDB → WhatsApp message sent to group
 *
 * Usage:
 *   npm run test:stage2
 *
 * Prerequisites:
 *   - .env filled in (including WHATSAPP_GROUP_ID)
 *   - MongoDB + Redis running (docker compose up -d)
 *   - WhatsApp auth saved (run npm start once and scan QR first)
 *   - storageState.json on S3 or locally (npm run login)
 */

require('dotenv').config();

const env = require('../src/config/env');
const { connectDB, disconnectDB } = require('../src/config/db');
const { runSync } = require('../src/services/syncService');
const { initWAClient, sendToGroup, destroyClient } = require('../src/whatsapp/waClient');
const logger = require('../src/utils/logger');

const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

async function run() {
  console.log('\n===========================================');
  console.log('  Stage 2 Smoke Test — AIT Placement Bot');
  console.log('===========================================\n');

  // 1. MongoDB
  log('STEP 1: Connecting to MongoDB...');
  await connectDB(env.mongoUri);
  log('✅ MongoDB connected\n');

  // 2. WhatsApp
  log('STEP 2: Initializing WhatsApp client (may show QR)...');
  await initWAClient();
  log('✅ WhatsApp ready\n');

  // 3. Send a test ping to verify group connectivity
  log('STEP 3: Sending test ping to group...');
  await sendToGroup('🤖 *AIT Placement Bot — Stage 2 Test*\n\nIf you see this, WhatsApp → Group send is working ✅');
  log('✅ Test ping sent to group\n');

  // 4. Run one sync cycle (will enqueue real notifications if new posts exist)
  log('STEP 4: Running one sync cycle...');
  const result = await runSync();
  log(`✅ Sync complete: ${result.newCount} new, ${result.updatedCount} updated\n`);

  console.log('===========================================');
  console.log('  ✅ Stage 2 Smoke Test PASSED');
  console.log('===========================================\n');
  console.log('Next steps:');
  console.log('  1. Check your WhatsApp group for the test ping and any new-drive messages');
  console.log('  2. If all good, run: npm start');
  console.log('     The bot will run continuously and sync every ' + env.syncIntervalMs / 1000 + 's\n');

  await destroyClient();
  await disconnectDB();
  process.exit(0);
}

run().catch(async (err) => {
  console.error('\n❌ Stage 2 Smoke Test FAILED:', err.message);
  if (err.stack) console.error(err.stack);
  await destroyClient().catch(() => {});
  await disconnectDB().catch(() => {});
  process.exit(1);
});
