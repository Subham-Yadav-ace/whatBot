#!/usr/bin/env node
'use strict';

/**
 * scripts/login.js
 *
 * One-time manual login to the AIT placement portal using Playwright.
 * Uses a VISIBLE Chrome window so you can handle Google OAuth and 2FA yourself.
 *
 * Steps:
 *   1. Opens your real Chrome browser with a visible window
 *   2. Navigates to the portal login page
 *   3. YOU log in manually (Google OAuth, 2FA, etc.)
 *   4. Press Enter in this terminal once you see the dashboard
 *   5. Script saves storageState.json locally + uploads to S3
 *
 * Usage:
 *   npm run login
 */

require('dotenv').config();

const { chromium } = require('playwright');
const path = require('path');
const readline = require('readline');
const { uploadStorageState } = require('../src/portal/sessionManager');
const env = require('../src/config/env');

const STORAGE_STATE_PATH = path.resolve(process.cwd(), 'storageState.json');

function waitForEnter(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  console.log('\n======================================');
  console.log('  AIT Placement Portal — Manual Login');
  console.log('======================================\n');
  console.log('Opening Chrome browser...');
  console.log(`Portal URL: ${env.portalBaseUrl}\n`);

  // Use system-installed Chrome for the most realistic browser fingerprint
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome', // Uses your real installed Chrome
    args: [
      '--no-sandbox', 
      '--start-maximized',
      '--disable-blink-features=AutomationControlled'
    ],
  });

  const context = await browser.newContext({
    viewport: null, // Use full window size
  });

  const page = await context.newPage();

  console.log('Navigating to portal...');
  await page.goto(env.portalBaseUrl, { waitUntil: 'domcontentloaded' });

  console.log('\n-----------------------------------------');
  console.log('ACTION REQUIRED:');
  console.log('  1. Log in with Google in the browser window');
  console.log('  2. Complete any 2FA / captcha');
  console.log('  3. Wait until you see the placement portal dashboard');
  console.log('  4. Come back here and press Enter');
  console.log('-----------------------------------------\n');

  await waitForEnter('Press Enter once you are logged in and see the dashboard...\n');

  console.log('Capturing session state...');
  await context.storageState({ path: STORAGE_STATE_PATH });
  console.log(`✅ storageState.json saved locally at: ${STORAGE_STATE_PATH}`);

  await browser.close();

  console.log('\nUploading storageState.json to S3...');
  try {
    await uploadStorageState(STORAGE_STATE_PATH);
    console.log('✅ Uploaded to S3 successfully!');
    console.log(`   Bucket: ${env.s3BucketName}`);
    console.log(`   Key:    ${env.s3StorageStateKey}`);
  } catch (err) {
    console.error('❌ S3 upload failed:', err.message);
    console.log('   The local storageState.json is still saved. You can upload manually.');
    process.exit(1);
  }

  console.log('\n✅ Login complete. The sync worker will now use this session automatically.');
  console.log('   Remember: session lasts ~1-2 weeks. Re-run this when you get a Telegram alert.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Login script failed:', err.message);
  process.exit(1);
});
