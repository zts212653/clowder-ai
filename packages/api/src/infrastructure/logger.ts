/**
 * F130: Centralized Pino Logger — stdout + pino-roll dual-write with redaction.
 *
 * KD-1: Self-built Pino instance passed to Fastify — usable outside Fastify too.
 * KD-5: Redaction ships with Phase A (logging to disk = copying leak surface).
 *
 * Usage:
 *   import { logger } from '../infrastructure/logger.js';
 *   logger.info({ threadId, catId }, 'Cat invoked');
 */

import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { format as utilFormat } from 'node:util';
import pino from 'pino';

/**
 * --debug CLI flag: `node dist/index.js --debug` sets log level to 'debug'.
 * Precedence: --debug flag > LOG_LEVEL env var > default 'info'.
 */
export const isDebugMode = process.argv.includes('--debug');
const LOG_LEVEL = (isDebugMode ? 'debug' : (process.env.LOG_LEVEL ?? 'info')) as pino.Level;
const LOG_DIR = process.env.LOG_DIR ? resolve(process.env.LOG_DIR) : resolve(process.cwd(), 'data', 'logs', 'api');
const RETENTION_FILES = 14;

/**
 * Pino redaction paths — masks values at these JSON paths.
 * Uses fast-redact: compiled once at creation, zero per-log overhead.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'authorization',
  'cookie',
  'token',
  'apiKey',
  'api_key',
  'secret',
  'password',
  'credential',
  'credentials',
  'callbackToken',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CAT_CAFE_ANTHROPIC_API_KEY',
];

if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Transport level is set to 'trace' (pass-through) so the parent logger's
 * `level` is the sole gate.  This ensures runtime level changes (e.g.
 * `logger.level = 'debug'`) take effect immediately — Pino transport workers
 * cache their level at init and ignore later parent-level changes.
 */
const transport = pino.transport({
  targets: [
    {
      target: 'pino/file',
      options: { destination: 1 },
      level: 'trace',
    },
    {
      target: 'pino-roll',
      options: {
        file: resolve(LOG_DIR, 'api.log'),
        frequency: 'daily',
        dateFormat: 'yyyy-MM-dd',
        limit: { count: RETENTION_FILES },
        mkdir: true,
      },
      level: 'trace',
    },
  ],
});

export const logger = pino(
  {
    level: LOG_LEVEL,
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
  },
  transport,
);

export function createModuleLogger(module: string): pino.Logger {
  return logger.child({ module });
}

export const LOG_DIR_PATH = LOG_DIR;

/**
 * KD-7: Redirect unmigrated console.* to both Pino log file AND stderr.
 *
 * - Pino child logger (`module: 'console'`) ensures console.* output is
 *   persisted in the rotating log file with the same redaction & format.
 * - stderr write preserved for process-layer `2>>` capture (orphan-free).
 */
const consoleLogger = logger.child({ module: 'console' });

const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

console.log = (...args: unknown[]) => {
  const msg = utilFormat(...args);
  consoleLogger.info(msg);
  origLog.apply(console, args);
};
console.warn = (...args: unknown[]) => {
  const msg = utilFormat(...args);
  consoleLogger.warn(msg);
  origWarn.apply(console, args);
};
console.error = (...args: unknown[]) => {
  const msg = utilFormat(...args);
  consoleLogger.error(msg);
  origError.apply(console, args);
};
