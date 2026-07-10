'use strict';

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const env = require('../config/env');
const logger = require('../utils/logger').child({ module: 'sessionManager' });

const s3 = new S3Client({ region: env.awsRegion });

const LOCAL_STORAGE_STATE_PATH = path.resolve(process.cwd(), 'storageState.json');

/**
 * Download storageState.json from S3 to the local filesystem.
 * Returns the local file path on success.
 * Throws if the file doesn't exist on S3 or download fails.
 */
async function downloadStorageState() {
  logger.info({ key: env.s3StorageStateKey }, 'Downloading storageState from S3...');

  const command = new GetObjectCommand({
    Bucket: env.s3BucketName,
    Key: env.s3StorageStateKey,
  });

  const response = await s3.send(command);

  // Stream the body to a file
  await new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(LOCAL_STORAGE_STATE_PATH);
    response.Body.pipe(writeStream);
    response.Body.on('error', reject);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  logger.info({ path: LOCAL_STORAGE_STATE_PATH }, 'storageState downloaded successfully');
  return LOCAL_STORAGE_STATE_PATH;
}

/**
 * Upload a local storageState.json file to S3.
 * Used after a manual re-login via scripts/login.js.
 */
async function uploadStorageState(localFilePath = LOCAL_STORAGE_STATE_PATH) {
  if (!fs.existsSync(localFilePath)) {
    throw new Error(`storageState file not found at: ${localFilePath}`);
  }

  logger.info({ localPath: localFilePath, key: env.s3StorageStateKey }, 'Uploading storageState to S3...');

  const command = new PutObjectCommand({
    Bucket: env.s3BucketName,
    Key: env.s3StorageStateKey,
    Body: fs.readFileSync(localFilePath),
    ContentType: 'application/json',
  });

  await s3.send(command);
  logger.info('storageState uploaded to S3 successfully');
}

/**
 * Read the local storageState.json and extract the session cookie value.
 * Returns the cookie string or null if not found.
 */
function extractSessionCookie(localFilePath = LOCAL_STORAGE_STATE_PATH) {
  if (!fs.existsSync(localFilePath)) {
    logger.warn('storageState.json not found locally — run "npm run login" first');
    return null;
  }

  const state = JSON.parse(fs.readFileSync(localFilePath, 'utf-8'));

  // Playwright storageState format: { cookies: [{ name, value, domain, ... }] }
  const cookie = (state.cookies || []).find((c) => c.name === env.sessionCookieName);

  if (!cookie) {
    logger.warn(
      { cookieName: env.sessionCookieName },
      'Session cookie not found in storageState.json'
    );
    return null;
  }

  logger.debug({ cookieName: cookie.name }, 'Session cookie extracted');
  return cookie.value;
}

module.exports = { downloadStorageState, uploadStorageState, extractSessionCookie };
