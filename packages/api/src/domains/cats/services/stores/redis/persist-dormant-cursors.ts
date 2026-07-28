/**
 * #1200 P1-3: One-shot SCAN/PERSIST migration for dormant cursor TTLs.
 *
 * Problem: Before #1200 Iron Law 5 flip, delivery-cursor / mention-ack /
 * seen-cursor keys were written with 7-day TTL. After the flip to ttl=0,
 * NEW writes are persistent but EXISTING keys still have the old TTL ticking.
 * If the key isn't touched before its TTL expires, the cursor is silently lost
 * → user sees stale unread state. This violates Iron Law 5 (user state default
 * persistent; TTL only by user opt-in).
 *
 * Fix: Scan all matching keys and PERSIST any that have a positive TTL.
 * The SET_IF_GREATER_LUA noop path also calls PERSIST (heal-on-touch),
 * but keys that are never touched before expiry won't benefit from that.
 *
 * Safety:
 *   - PERSIST is idempotent (no-op on already-persistent keys)
 *   - SCAN is non-blocking (cursor-based iteration)
 *   - No data mutation — only TTL removal
 *
 * Usage: import { persistDormantCursors } from './persist-dormant-cursors.js';
 *        const result = await persistDormantCursors(redis);
 *        // { scanned: 12000, persisted: 342, errors: 0 }
 */

import type { RedisClient } from '@cat-cafe/shared/utils';

/** Key namespace patterns that should be persistent (Iron Law 5) */
const CURSOR_PATTERNS = ['delivery-cursor:*', 'mention-ack:*', 'seen-cursor:*'] as const;

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
 * @param redis - Connected Redis client (with keyPrefix configured)
 * @param batchSize - SCAN COUNT hint per iteration (default 200)
 * @returns Summary of what was scanned and persisted
 */
export async function persistDormantCursors(redis: RedisClient, batchSize = 200): Promise<PersistResult> {
  const result: PersistResult = {
    scanned: 0,
    persisted: 0,
    alreadyPersistent: 0,
    errors: 0,
    patterns: {},
  };

  for (const pattern of CURSOR_PATTERNS) {
    const patternResult = { persisted: 0, total: 0 };
    let cursor = '0';

    do {
      // SCAN with pattern match — returns [nextCursor, keys[]]
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', batchSize);
      cursor = nextCursor;

      for (const key of keys) {
        patternResult.total++;
        result.scanned++;

        try {
          const ttl = await redis.ttl(key);
          if (ttl > 0) {
            // Key has a TTL — PERSIST it
            await redis.persist(key);
            patternResult.persisted++;
            result.persisted++;
          } else {
            // ttl === -1 (persistent) or -2 (expired/missing)
            result.alreadyPersistent++;
          }
        } catch {
          result.errors++;
        }
      }
    } while (cursor !== '0');

    result.patterns[pattern] = patternResult;
  }

  return result;
}
