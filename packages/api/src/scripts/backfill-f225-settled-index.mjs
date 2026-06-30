#!/usr/bin/env node
/**
 * F246 Phase G: Backfill handoff-proposals:settled:{userId} sorted set
 * for F225 SessionHandoffProposals approved/rejected before Phase G merge.
 *
 * Background:
 *   Phase G added a settled sorted set (handoff-proposals:settled:{userId})
 *   written as a pipeline ZADD in finalizeApproval() and markRejected().
 *   Proposals settled BEFORE Phase G lack entries in this index — their
 *   detail hashes are still intact (TTL=0, LL-048), but listSettledByUser()
 *   can't find them via the new settled sorted set.
 *
 * What this script does:
 *   1. SCAN for all `cat-cafe:handoff-proposal:*` keys (detail hashes)
 *   2. HGETALL each hash, filter status=approved|rejected
 *   3. Check whether proposalId is already in the settled sorted set
 *   4. ZADD missing entries with score=updatedAt
 *
 * Safety:
 *   - Default: DRY RUN — prints a plan, writes nothing.
 *   - Pass --apply to execute writes.
 *   - Additive only: no existing data is modified or deleted.
 *   - Idempotent: safe to run multiple times.
 *
 * Usage:
 *   node packages/api/src/scripts/backfill-f225-settled-index.mjs
 *   node packages/api/src/scripts/backfill-f225-settled-index.mjs --apply
 *   # Production (explicit override required — default is dev Redis 6398):
 *   REDIS_URL=redis://localhost:6399 node packages/api/src/scripts/backfill-f225-settled-index.mjs --apply
 */

import { Redis } from 'ioredis';

// Default to dev Redis (6398). Production requires REDIS_URL=redis://localhost:6399 explicitly.
// Never default to 6399 — Redis 6399 is the sacred production instance (LL-015).
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6398';
const KEY_PREFIX = 'cat-cafe:';
/** SCAN pattern for handoff-proposal detail hashes */
const DETAIL_SCAN_PATTERN = `${KEY_PREFIX}handoff-proposal:*`;
/** Index keys look like handoff-proposals:* (plural 's'), skip them */
const INDEX_INFIX = `${KEY_PREFIX}handoff-proposals:`;
const SETTLED_KEY = (userId) => `${KEY_PREFIX}handoff-proposals:settled:${userId}`;
const DRY_RUN = !process.argv.includes('--apply');

async function main() {
  console.log(`\n=== F246 Phase G: Backfill F225 settled index ===`);
  console.log(`Redis: ${REDIS_URL}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (pass --apply to write)' : '⚡ APPLY'}\n`);

  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
  });

  redis.on('error', (err) => {
    console.error('[Redis] Error:', err.message);
    process.exit(1);
  });

  await redis.ping();
  console.log('[Redis] Connected ✓\n');

  let scanned = 0;
  let skippedIndexKeys = 0;
  let skippedNonSettled = 0;
  let alreadyIndexed = 0;
  let toBackfill = 0;
  let backfilled = 0;

  const entries = []; // { proposalId, userId, updatedAt, status }
  let cursor = '0';

  // Phase 1: Scan + collect candidates
  process.stdout.write('Scanning Redis keys...');
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', DETAIL_SCAN_PATTERN, 'COUNT', 100);
    cursor = nextCursor;

    for (const key of keys) {
      scanned++;

      // Skip index keys — they contain 'handoff-proposals:' (plural 's')
      if (key.startsWith(INDEX_INFIX)) {
        skippedIndexKeys++;
        continue;
      }

      const raw = await redis.hgetall(key);
      if (!raw || !raw.status) continue;

      if (raw.status !== 'approved' && raw.status !== 'rejected') {
        skippedNonSettled++;
        continue;
      }

      if (!raw.proposalId || !raw.userId || !raw.updatedAt) {
        console.warn(`\n[WARN] Settled proposal missing required fields: ${key}`, {
          proposalId: raw.proposalId,
          userId: raw.userId,
          updatedAt: raw.updatedAt,
          status: raw.status,
        });
        continue;
      }

      entries.push({
        key,
        proposalId: raw.proposalId,
        userId: raw.userId,
        updatedAt: Number(raw.updatedAt),
        status: raw.status,
      });
    }
  } while (cursor !== '0');

  console.log(` done.\n`);
  console.log(`Keys scanned:        ${scanned}`);
  console.log(`Skipped (index):     ${skippedIndexKeys}`);
  console.log(`Skipped (pending):   ${skippedNonSettled}`);
  console.log(`Settled candidates:  ${entries.length}\n`);

  if (entries.length === 0) {
    console.log('No settled F225 proposals found. Nothing to backfill.');
    await redis.quit();
    return;
  }

  // Phase 2: Check which entries are already in the settled sorted set
  console.log('Checking settled sorted set membership...');
  for (const entry of entries) {
    const settledKey = SETTLED_KEY(entry.userId);
    const score = await redis.zscore(settledKey, entry.proposalId);

    if (score !== null) {
      alreadyIndexed++;
      entry.alreadyIndexed = true;
    } else {
      toBackfill++;
      entry.alreadyIndexed = false;
    }
  }

  console.log(`Already indexed:     ${alreadyIndexed}`);
  console.log(`To backfill:         ${toBackfill}\n`);

  const missing = entries.filter((e) => !e.alreadyIndexed);

  if (missing.length === 0) {
    console.log('✅ All settled F225 proposals are already indexed. Nothing to do.');
    await redis.quit();
    return;
  }

  // Show plan
  console.log('=== Backfill Plan ===');
  for (const entry of missing) {
    const settledKey = SETTLED_KEY(entry.userId);
    const decidedDate = new Date(entry.updatedAt).toISOString();
    console.log(`  ZADD ${settledKey} ${entry.updatedAt} ${entry.proposalId}`);
    console.log(`       (${entry.status}, updatedAt=${decidedDate}, userId=${entry.userId})`);
  }
  console.log();

  if (DRY_RUN) {
    console.log(`DRY RUN: ${toBackfill} entries would be added. Run with --apply to write.`);
    await redis.quit();
    return;
  }

  // Phase 3: Apply
  console.log(`Applying ${toBackfill} backfill entries...`);
  const pipeline = redis.pipeline();
  for (const entry of missing) {
    pipeline.zadd(SETTLED_KEY(entry.userId), entry.updatedAt, entry.proposalId);
    backfilled++;
  }
  await pipeline.exec();

  console.log(`\n✅ Done! ${backfilled} entries added to F225 settled sorted sets.`);
  console.log('Verification: GET /api/approval-hub/settled should now show F225 history.');

  await redis.quit();
}

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
