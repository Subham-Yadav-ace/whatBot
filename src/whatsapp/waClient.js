'use strict';

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
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
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      timeout: 0,   // disable Puppeteer's own navigation timeout — we use our own 5-min timeout
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        // '--no-zygote' removed — causes renderer subprocess issues without --single-process
        '--disable-gpu',
        '--disable-crash-reporter',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--remote-debugging-port=0',
      ],
    },
  });

  c.on('qr', (qr) => {
    logger.info('WhatsApp QR received — scan with your phone:');
    qrcode.generate(qr, { small: true });
  });

  c.on('authenticated', () => logger.info('WhatsApp authenticated'));

  c.on('loading_screen', (percent, message) => {
    logger.info({ percent, message }, 'WhatsApp loading...');
  });

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

  // 5-minute timeout — EC2 instances can be slow on cold start after a restart.
  // 'authenticated' fires quickly but 'ready' waits for WhatsApp Web to fully load.
  const INIT_TIMEOUT_MS = 5 * 60 * 1000;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`WhatsApp init timed out after ${INIT_TIMEOUT_MS / 1000}s — Chromium may be too slow to load`)),
      INIT_TIMEOUT_MS
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
async function sendToGroup(message, attachments = []) {
  if (!isReady || !client) {
    throw new Error('WhatsApp client not ready');
  }
  if (!env.whatsappGroupId) {
    throw new Error('WHATSAPP_GROUP_ID is not set in .env');
  }
  await client.sendMessage(env.whatsappGroupId, message);
  logger.info({ groupId: env.whatsappGroupId }, 'Message sent to group');

  for (const attachment of attachments) {
    try {
      if (attachment.url) {
        const media = await MessageMedia.fromUrl(attachment.url, { unsafeMime: true, filename: attachment.fileName });
        await client.sendMessage(env.whatsappGroupId, media, { caption: attachment.fileName });
        logger.info({ fileName: attachment.fileName }, 'Attachment sent');
      } else if (attachment.base64Data) {
        const media = new MessageMedia(attachment.mimeType, attachment.base64Data, attachment.fileName);
        await client.sendMessage(env.whatsappGroupId, media, { caption: attachment.fileName });
        logger.info({ fileName: attachment.fileName }, 'Base64 Attachment sent');
      }
    } catch (err) {
      logger.error({ err: err.message, url: attachment.url || attachment.fileName }, 'Failed to send attachment');
    }
  }
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
