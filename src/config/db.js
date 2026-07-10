'use strict';

const mongoose = require('mongoose');
const logger = require('../utils/logger').child({ module: 'db' });

let isConnected = false;

/**
 * Connect to MongoDB with retry logic.
 * Uses a simple exponential backoff for connection retries.
 */
async function connectDB(uri, retries = 5, delay = 2000) {
  if (isConnected) {
    logger.info('Already connected to MongoDB');
    return;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 10000,
      });

      isConnected = true;
      logger.info({ uri: uri.replace(/\/\/[^@]+@/, '//***@') }, 'MongoDB connected');
      break;
    } catch (err) {
      logger.error({ err, attempt, retries }, 'MongoDB connection failed');
      if (attempt < retries) {
        const wait = delay * attempt;
        logger.info({ wait }, `Retrying in ${wait}ms...`);
        await new Promise((r) => setTimeout(r, wait));
      } else {
        throw new Error(`Failed to connect to MongoDB after ${retries} attempts: ${err.message}`);
      }
    }
  }

  mongoose.connection.on('disconnected', () => {
    isConnected = false;
    logger.warn('MongoDB disconnected');
  });

  mongoose.connection.on('error', (err) => {
    logger.error({ err }, 'MongoDB connection error');
  });

  mongoose.connection.on('reconnected', () => {
    isConnected = true;
    logger.info('MongoDB reconnected');
  });
}

async function disconnectDB() {
  if (!isConnected) return;
  await mongoose.disconnect();
  isConnected = false;
  logger.info('MongoDB disconnected gracefully');
}

module.exports = { connectDB, disconnectDB };
