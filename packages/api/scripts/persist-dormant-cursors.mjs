#!/usr/bin/env node
/**
 * #1200 P1-3: One-shot CLI for persisting dormant cursor TTLs.
 *
 * Run BEFORE deploying the Iron Law 5 TTL flip (or as soon as possible after)
 * to heal keys that still have the old 7-day TTL.
 *
 * Usage:
 *   node scripts/persist-dormant-cursors.mjs
 *   # or: pnpm persist-dormant-cursors
 *
 * Prerequisites:
 *   - pnpm build (needs compiled dist/)
 *   - REDIS_URL env var (defaults to redis://localhost:6399)
 *
 * Idempotent: safe to run multiple times.
 */

import { createRedisClient } from '@cat-cafe/shared/utils';

const { persistDormantCursors } = await import('../dist/domains/cats/services/stores/redis/persist-dormant-cursors.js');

console.log('[persist-dormant-cursors] Starting one-shot TTL migration...');

const redis = createRedisClient();

try {
  await redis.ping();
  console.log('[persist-dormant-cursors] Redis connected');

  const result = await persistDormantCursors(redis);

  console.log('[persist-dormant-cursors] Migration complete:');
  console.log(`  Scanned:           ${result.scanned}`);
  console.log(`  Persisted:         ${result.persisted}`);
  console.log(`  Already persistent: ${result.alreadyPersistent}`);
  console.log(`  Errors:            ${result.errors}`);
  for (const [pattern, stats] of Object.entries(result.patterns)) {
    console.log(`  ${pattern}: ${stats.persisted}/${stats.total} persisted`);
  }

  if (result.errors > 0) {
    console.error('[persist-dormant-cursors] Completed with errors — review above');
    process.exit(1);
  }

  process.exit(0);
} catch (err) {
  console.error('[persist-dormant-cursors] Fatal error:', err);
  process.exit(1);
} finally {
  await redis.quit().catch(() => {});
}
