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
 * KD-7: Redirect unmigrated console.* to both Pino and stderr.
 * Sanitize args before utilFormat so secrets cannot leak through msg strings.
 */
const consoleLogger = logger.child({ module: 'console' });

const SENSITIVE_KEYS = new Set(
  REDACT_PATHS.map((path) => {
    const segments = path.split(/[.[]/);
    return segments[segments.length - 1].replace(/[\]"]/g, '').trim().toLowerCase();
  }).filter(Boolean),
);

function sanitizeEntries(obj: object, visited: WeakSet<object>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : sanitizeArg(value, visited);
  }
  return result;
}

function sanitizeArg(value: unknown, seen?: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  const visited = seen ?? new WeakSet<object>();
  if (visited.has(value as object)) return '[Circular]';
  visited.add(value as object);
  if (Array.isArray(value)) return value.map((item) => sanitizeArg(item, visited));
  if (ArrayBuffer.isView(value)) return value;
  if (value instanceof Error) {
    const cleaned: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    try {
      Object.assign(cleaned, sanitizeEntries(value, visited));
    } catch {
      /* ignore throwing getters */
    }
    return cleaned;
  }
  try {
    return sanitizeEntries(value as Record<string, unknown>, visited);
  } catch {
    return '[Object]';
  }
}

type ConsolePinoLevel = 'info' | 'warn' | 'error' | 'debug';
type ConsoleMethodLabel = 'log' | 'warn' | 'error' | 'info' | 'debug';

function consoleToPino(level: ConsolePinoLevel, stderrLabel: ConsoleMethodLabel): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    const sanitized = args.map((arg) => sanitizeArg(arg));
    const msg = utilFormat(...sanitized);
    consoleLogger[level](msg);
    process.stderr.write(`[console.${stderrLabel}] ${msg}\n`);
  };
}

console.log = consoleToPino('info', 'log');
console.warn = consoleToPino('warn', 'warn');
console.error = consoleToPino('error', 'error');
console.info = consoleToPino('info', 'info');
console.debug = consoleToPino('debug', 'debug');
