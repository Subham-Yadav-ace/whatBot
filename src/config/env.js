'use strict';

require('dotenv').config();

/**
 * Centralized environment variable loader.
 * Validates all required variables on startup so we fail fast with
 * a clear error instead of mysterious runtime crashes.
 */

const REQUIRED = [
  'PORTAL_BASE_URL',
  'MONGO_URI',
  'REDIS_HOST',
  'REDIS_PORT',
  'S3_BUCKET_NAME',
  'AWS_REGION',
  'GEMINI_API_KEY',
];

function validate() {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `[env] Missing required environment variables:\n  ${missing.join('\n  ')}\n` +
        `Copy .env.example to .env and fill in the values.`
    );
  }
}

validate();

const env = {
  // Placement Portal
  portalBaseUrl: process.env.PORTAL_BASE_URL,
  portalAuthTokenPath: process.env.PORTAL_AUTH_TOKEN_PATH || '/api/auth/token',
  portalPostListPath: process.env.PORTAL_POST_LIST_PATH || '/api/post/list',
  portalPostDetailPath: process.env.PORTAL_POST_DETAIL_PATH || '/api/post',
  portalAttachmentPath: process.env.PORTAL_ATTACHMENT_PATH || '/api/attachment',
  sessionCookieName: process.env.SESSION_COOKIE_NAME || '__Secure-better-auth.session_token',

  // MongoDB
  mongoUri: process.env.MONGO_URI,

  // Redis
  redisHost: process.env.REDIS_HOST || 'localhost',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  redisPassword: process.env.REDIS_PASSWORD || undefined,

  // AWS S3
  awsRegion: process.env.AWS_REGION,
  s3BucketName: process.env.S3_BUCKET_NAME,
  s3StorageStateKey: process.env.S3_STORAGE_STATE_KEY || 'auth/storageState.json',

  // Gemini AI
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',

  // Admin Alerts (Telegram)
  adminTelegramBotToken: process.env.ADMIN_TELEGRAM_BOT_TOKEN || '',
  adminTelegramChatId: process.env.ADMIN_TELEGRAM_CHAT_ID || '',

  // Sync
  syncIntervalMs: parseInt(process.env.SYNC_INTERVAL_MS || '300000', 10),

  // WhatsApp
  whatsappAuthFolder: process.env.WHATSAPP_AUTH_FOLDER || './whatsapp_auth',
  whatsappSendDelayMs: parseInt(process.env.WHATSAPP_SEND_DELAY_MS || '1500', 10),
  whatsappGroupId: process.env.WHATSAPP_GROUP_ID || '',

  // Daily Digest
  dailyDigestCron: process.env.DAILY_DIGEST_CRON || '0 9 * * *',

  // App
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  isDev: (process.env.NODE_ENV || 'development') === 'development',
};

module.exports = env;
