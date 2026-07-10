'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const env = require('../config/env');
const logger = require('../utils/logger').child({ module: 'waClient' });
const { sendAlert } = require('../utils/adminAlert');

let client = null;
let isReady = false;

function buildClient() {
  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: env.whatsappAuthFolder }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
      ],
    },
  });

  c.on('qr', (qr) => {
    logger.info('WhatsApp QR received — scan with your phone:');
    qrcode.generate(qr, { small: true });
  });

  c.on('authenticated', () => logger.info('WhatsApp authenticated'));

  c.on('ready', () => {
    isReady = true;
    logger.info('WhatsApp client ready ✅');
  });

  c.on('auth_failure', (msg) => {
    isReady = false;
    logger.error({ msg }, 'WhatsApp auth failure');
    sendAlert('❌ *WhatsApp Auth Failure*\n\nDelete the auth folder and re-scan the QR code.');
  });

  c.on('disconnected', (reason) => {
    isReady = false;
    logger.warn({ reason }, 'WhatsApp disconnected');
    sendAlert(`⚠️ *WhatsApp Disconnected*\n\nReason: ${reason}\n\nBot will attempt to reconnect.`);
  });

  return c;
}

/**
 * Initialise the WhatsApp client and wait until ready.
 * Call once at startup; subsequent calls are no-ops if already ready.
 */
async function initWAClient() {
  if (isReady) return client;

  client = buildClient();

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('WhatsApp init timed out after 120s — scan the QR code')),
      120_000
    );

    client.once('ready', () => {
      clearTimeout(timeout);
      resolve();
    });

    client.once('auth_failure', (msg) => {
      clearTimeout(timeout);
      reject(new Error(`WhatsApp auth failed: ${msg}`));
    });

    client.initialize().catch(reject);
  });

  return client;
}

/**
 * Send a plain-text message to the configured WhatsApp group.
 */
async function sendToGroup(message) {
  if (!isReady || !client) {
    throw new Error('WhatsApp client not ready');
  }
  if (!env.whatsappGroupId) {
    throw new Error('WHATSAPP_GROUP_ID is not set in .env');
  }
  await client.sendMessage(env.whatsappGroupId, message);
  logger.info({ groupId: env.whatsappGroupId }, 'Message sent to group');
}

/**
 * Graceful shutdown — call in SIGTERM handler.
 */
async function destroyClient() {
  if (client) {
    await client.destroy();
    client = null;
    isReady = false;
    logger.info('WhatsApp client destroyed');
  }
}

module.exports = { initWAClient, sendToGroup, destroyClient };
