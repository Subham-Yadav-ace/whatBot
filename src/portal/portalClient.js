'use strict';

const axios = require('axios');
const env = require('../config/env');
const logger = require('../utils/logger').child({ module: 'portalClient' });

// Lazy import to avoid circular dependency at startup (adminAlert needs logger)
let adminAlert;
function getAdminAlert() {
  if (!adminAlert) adminAlert = require('../utils/adminAlert');
  return adminAlert;
}

/**
 * Build a cookie header string from a cookie name+value.
 */
function buildCookieHeader(name, value) {
  return `${name}=${value}`;
}

/**
 * Fetch a fresh JWT from the portal using the session cookie.
 *
 * On success: returns the JWT string.
 * On 401:     fires admin Telegram alert and throws so callers know to abort.
 * On other errors: throws with context.
 */
async function getFreshJWT(sessionCookieValue) {
  const url = `${env.portalBaseUrl}${env.portalAuthTokenPath}`;
  logger.debug({ url }, 'Fetching fresh JWT...');

  try {
    const response = await axios.get(url, {
      headers: {
        Cookie: buildCookieHeader(env.sessionCookieName, sessionCookieValue),
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      timeout: 15000,
    });

    const token = response.data?.token;
    if (!token) {
      throw new Error(`Unexpected response shape from auth endpoint: ${JSON.stringify(response.data)}`);
    }

    logger.info('JWT fetched successfully');
    return token;
  } catch (err) {
    if (err.response?.status === 401) {
      logger.warn('Portal session expired (401) — alerting admin');
      await getAdminAlert().sendAlert(
        '⚠️ *Portal Session Expired*\n\nThe placement portal session cookie has expired.\n\nRun `npm run login` on your machine to re-authenticate and upload a fresh storageState to S3.'
      );
      throw new Error('SESSION_EXPIRED');
    }

    logger.error({ err: err.message, status: err.response?.status }, 'Failed to fetch JWT');
    throw err;
  }
}

/**
 * Fetch the list of all placement posts (lightweight — id, title, updatedAt).
 */
async function fetchPostList(jwt) {
  const url = `${env.portalBaseUrl}${env.portalPostListPath}`;
  logger.debug({ url }, 'Fetching post list...');

  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
    timeout: 20000,
  });

  const posts = response.data?.posts || [];
  logger.info({ count: posts.length }, 'Post list fetched');
  return posts;
}

/**
 * Fetch the full detail of a single post (includes HTML body, details, etc.).
 */
async function fetchPostDetail(jwt, postId) {
  const url = `${env.portalBaseUrl}${env.portalPostDetailPath}/${postId}`;
  logger.debug({ url, postId }, 'Fetching post detail...');

  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
    timeout: 20000,
  });

  logger.debug({ postId }, 'Post detail fetched');
  return response.data;
}

/**
 * Fetch attachments (PDFs, files) for a given post.
 */
async function fetchAttachments(jwt, postId) {
  const url = `${env.portalBaseUrl}${env.portalAttachmentPath}?postId=${postId}`;
  logger.debug({ url, postId }, 'Fetching attachments...');

  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
    timeout: 15000,
  });

  const attachments = response.data?.attachments || [];
  logger.debug({ postId, count: attachments.length }, 'Attachments fetched');
  return attachments;
}

module.exports = { getFreshJWT, fetchPostList, fetchPostDetail, fetchAttachments };
