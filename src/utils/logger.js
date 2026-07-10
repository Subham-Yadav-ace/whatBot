'use strict';

const pino = require('pino');
const env = require('../config/env');

const transport =
  env.isDev
    ? pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname',
        },
      })
    : undefined;

const logger = pino(
  {
    level: env.logLevel,
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  transport
);

module.exports = logger;
