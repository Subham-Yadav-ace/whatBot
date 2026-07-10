'use strict';

const { Redis } = require('ioredis');
const env = require('./env');
const logger = require('../utils/logger').child({ module: 'redis' });

/** Shared ioredis connection options */
const connectionOptions = {
  host: env.redisHost,
  port: env.redisPort,
  ...(env.redisPassword ? { password: env.redisPassword } : {}),
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: false,    // Required by BullMQ
  lazyConnect: false,
  retryStrategy(times) {
    const delay = Math.min(times * 500, 5000);
    logger.warn({ times, delay }, 'Redis reconnecting...');
    return delay;
  },
};

let _connection = null;

/**
 * Returns the shared Redis connection for BullMQ.
 * BullMQ requires maxRetriesPerRequest: null.
 */
function getRedisConnection() {
  if (_connection) return _connection;

  _connection = new Redis(connectionOptions);

  _connection.on('connect', () => logger.info('Redis connected'));
  _connection.on('ready', () => logger.info('Redis ready'));
  _connection.on('error', (err) => logger.error({ err }, 'Redis error'));
  _connection.on('close', () => logger.warn('Redis connection closed'));
  _connection.on('reconnecting', () => logger.warn('Redis reconnecting'));

  return _connection;
}

/**
 * Creates a fresh Redis connection (for BullMQ workers that need their own).
 */
function createRedisConnection() {
  return new Redis(connectionOptions);
}

module.exports = { getRedisConnection, createRedisConnection };
