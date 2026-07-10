#!/usr/bin/env node
'use strict';

/**
 * scripts/getGroupId.js
 *
 * One-time helper to list all WhatsApp groups your number is in.
 * Copy the ID of your target group and add it to WHATSAPP_GROUP_ID in .env.
 *
 * Usage:
 *   node scripts/getGroupId.js
 *
 * Note: If you have already run npm start once and scanned the QR, the saved
 * auth session in WHATSAPP_AUTH_FOLDER will be reused — no QR needed again.
 */

require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const env = require('../src/config/env');

console.log('\n=========================================');
console.log('  WhatsApp Group ID Finder');
console.log('=========================================\n');

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: env.whatsappAuthFolder }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
});

client.on('qr', (qr) => {
  console.log('Scan this QR with WhatsApp:\n');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => console.log('✅ Authenticated\n'));

client.on('ready', async () => {
  console.log('✅ WhatsApp ready — fetching your groups...\n');

  const chats = await client.getChats();
  const groups = chats.filter((c) => c.isGroup);

  if (groups.length === 0) {
    console.log('⚠️  No groups found. Make sure the number is in at least one group.');
  } else {
    console.log(`Found ${groups.length} group(s):\n`);
    groups.forEach((g, i) => {
      console.log(`[${i + 1}] Name: ${g.name}`);
      console.log(`     ID:   ${g.id._serialized}`);
      console.log(`     Participants: ${g.participants?.length ?? '?'}`);
      console.log();
    });
    console.log('─────────────────────────────────────────');
    console.log('Copy the ID of your target group and add it to .env:');
    console.log('  WHATSAPP_GROUP_ID=<paste id here>');
    console.log('─────────────────────────────────────────\n');
  }

  await client.destroy();
  process.exit(0);
});

client.on('auth_failure', (msg) => {
  console.error('❌ Auth failure:', msg);
  process.exit(1);
});

client.initialize().catch((err) => {
  console.error('Client init failed:', err.message);
  process.exit(1);
});
