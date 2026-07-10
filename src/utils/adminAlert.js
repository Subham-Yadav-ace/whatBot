'use strict';

const axios = require('axios');
const env = require('../config/env');
const logger = require('./logger').child({ module: 'adminAlert' });

/**
 * Send a Telegram message to the admin.
 * Uses MarkdownV2 parse mode for formatting.
 * Silently swallows errors so a failing alert never crashes the main process.
 */
async function sendAlert(text) {
  if (!env.adminTelegramBotToken || !env.adminTelegramChatId) {
    logger.warn('Telegram admin alert not configured — skipping alert');
    logger.warn({ text }, 'Alert content (would have been sent)');
    return;
  }

  const url = `https://api.telegram.org/bot${env.adminTelegramBotToken}/sendMessage`;

  try {
    await axios.post(
      url,
      {
        chat_id: env.adminTelegramChatId,
        text,
        parse_mode: 'Markdown',
      },
      { timeout: 10000 }
    );
    logger.info('Admin Telegram alert sent');
  } catch (err) {
    // Never let a failed alert crash the bot — just log it
    logger.error({ err: err.message }, 'Failed to send admin Telegram alert');
  }
}

module.exports = { sendAlert };
