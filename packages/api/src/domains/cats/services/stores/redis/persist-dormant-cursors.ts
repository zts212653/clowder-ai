/**
 * #1200 P1-3: One-shot SCAN/PERSIST migration for dormant cursor TTLs.
 *
 * Problem: Before #1200 Iron Law 5 flip, delivery-cursor / mention-ack /
 * seen-cursor keys were written with 7-day TTL. After the flip to ttl=0,
 * NEW writes are persistent but EXISTING keys still have the old TTL ticking.
 * If the key isn't touched before its TTL expires, the cursor is silently lost
 * → user sees stale unread state. This violates Iron Law 5.
 *
 * Fix: Scan all matching keys and PERSIST any that have a positive TTL.
 *
 * #1200 Sol R2: ioredis keyPrefix awareness.
 * ioredis auto-prefixes KEYS[] in commands like GET/SET, but SCAN MATCH
 * operates on raw key names. When keyPrefix='cat-cafe:', the actual Redis
 * keys are 'cat-cafe:delivery-cursor:...' so SCAN MATCH must use the
 * prefixed pattern. Similarly, TTL/PERSIST commands go through ioredis
 * which auto-prefixes — so we must STRIP the prefix from scan results
 * before passing to TTL/PERSIST.
 *
 * Safety:
 *   - PERSIST is idempotent (no-op on already-persistent keys)
 *   - SCAN is non-blocking (cursor-based iteration)
 *   - No data mutation — only TTL removal
 *
 * Usage:
 *   import { persistDormantCursors } from './persist-dormant-cursors.js';
 *   const result = await persistDormantCursors(redis);
 *   // { scanned: 12000, persisted: 342, errors: 0 }
 *
 * CLI: pnpm persist-dormant-cursors (see package.json script)
 */

import type { RedisClient } from '@cat-cafe/shared/utils';

/** Key namespace patterns (WITHOUT prefix — ioredis handles prefixing) */
const CURSOR_NAMESPACES = ['delivery-cursor', 'mention-ack', 'seen-cursor'] as const;

export interface PersistResult {
  scanned: number;
  persisted: number;
  alreadyPersistent: number;
  errors: number;
  patterns: Record<string, { persisted: number; total: number }>;
}

/**
 * Scan and PERSIST all cursor keys that still have a TTL.
 *
 * Uses a raw (unprefixed) Redis client for SCAN to see actual key names,
 * then strips the prefix before passing to ioredis TTL/PERSIST (which
 * auto-prefix). This avoids double-prefixing.
 *
 * @param redis - Connected ioredis client (with keyPrefix configured)
 * @param batchSize - SCAN COUNT hint per iteration (default 200)
 * @returns Summary of what was scanned and persisted
 */
export async function persistDormantCursors(redis: RedisClient, batchSize = 200): Promise<PersistResult> {
  const keyPrefix = ((redis.options as Record<string, unknown>).keyPrefix as string) ?? '';

  const result: PersistResult = {
    scanned: 0,
    persisted: 0,
    alreadyPersistent: 0,
    errors: 0,
    patterns: {},
  };

  for (const ns of CURSOR_NAMESPACES) {
    const patternResult = { persisted: 0, total: 0 };
    // SCAN MATCH needs the full key name including ioredis prefix
    const scanPattern = `${keyPrefix}${ns}:*`;
    let cursor = '0';

    do {
      // Use sendCommand to bypass ioredis auto-prefixing for SCAN
      const [nextCursor, rawKeys] = (await redis.call(
        'SCAN',
        cursor,
        'MATCH',
        scanPattern,
        'COUNT',
        String(batchSize),
      )) as [string, string[]];
      cursor = nextCursor;

      for (const rawKey of rawKeys) {
        patternResult.total++;
        result.scanned++;

        try {
          // Use redis.call() to bypass ioredis auto-prefixing — rawKey is already
          // the full key name as it appears in Redis (includes keyPrefix).
          const ttl = (await redis.call('TTL', rawKey)) as number;
          if (ttl > 0) {
            await redis.call('PERSIST', rawKey);
            patternResult.persisted++;
            result.persisted++;
          } else {
            result.alreadyPersistent++;
          }
        } catch {
          result.errors++;
        }
      }
    } while (cursor !== '0');

    result.patterns[ns] = patternResult;
  }

  return result;
}
