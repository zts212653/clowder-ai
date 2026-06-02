/**
 * Issue #845 — Backfill missing usageByCat on succeeded invocations.
 *
 * Background:
 *   QueueProcessor previously wrote `status: succeeded` without `usageByCat`, so 159+
 *   historical invocations have token usage in their messages (`metadata.usage`) but
 *   nothing in the daily usage report. The forward-fix patches the writer; this script
 *   repairs the historical orphans.
 *
 * Usage:
 *   pnpm --filter @cat-cafe/api build
 *   node packages/api/dist/scripts/backfill-usage-by-cat.js --dry-run --days 30
 *   # review the preview, then:
 *   node packages/api/dist/scripts/backfill-usage-by-cat.js --apply --days 30
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { RedisInvocationRecordStore } from '../domains/cats/services/stores/redis/RedisInvocationRecordStore.js';
import { RedisMessageStore } from '../domains/cats/services/stores/redis/RedisMessageStore.js';
import {
  type BackfillPlan,
  formatBackfillPreview,
  indexMessagesByInvocation,
  planBackfill,
} from './backfill-usage-by-cat/core.js';

interface CliArgs {
  dryRun: boolean;
  days: number;
  redisUrl?: string;
  keyPrefix?: string;
  help: boolean;
}

const USAGE = `Usage: node dist/scripts/backfill-usage-by-cat.js [options]

Repair invocations where status=succeeded but usageByCat is missing, by
re-aggregating token usage from the message store (metadata.usage on each
cat message that targets the same parent invocation).

Options:
  --dry-run           (default) plan only, do not write
  --apply             execute writes
  --days <N>          window in days, default 30
  --redis-url <url>   override REDIS_URL
  --key-prefix <p>    override REDIS_KEY_PREFIX (default: cat-cafe:)
  --help              print this help
`;

function parseArgs(argv: readonly string[]): CliArgs {
  let dryRun = true;
  let days = 30;
  let redisUrl: string | undefined;
  let keyPrefix: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      dryRun = false;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--days' || arg === '--redis-url' || arg === '--key-prefix') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === '--days') {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`--days requires a positive integer, got: ${value}`);
        }
        days = parsed;
      } else if (arg === '--redis-url') {
        redisUrl = value;
      } else if (arg === '--key-prefix') {
        keyPrefix = value;
      }
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { dryRun, days, ...(redisUrl ? { redisUrl } : {}), ...(keyPrefix ? { keyPrefix } : {}), help };
}

async function applyPlan(
  plan: BackfillPlan,
  store: RedisInvocationRecordStore,
): Promise<{ applied: number; failed: number }> {
  let applied = 0;
  let failed = 0;
  for (const entry of plan.entries) {
    try {
      const updated = await store.update(entry.invocationId, {
        usageByCat: entry.usageByCat,
        usageRecordedAt: entry.usageRecordedAt,
      });
      if (updated) {
        applied += 1;
      } else {
        // CAS mismatch (e.g. record was meanwhile updated by another writer) — record but continue
        failed += 1;
        console.warn(`[backfill-usage] update returned null for ${entry.invocationId} (CAS mismatch / not found)`);
      }
    } catch (err) {
      failed += 1;
      console.error(`[backfill-usage] update failed for ${entry.invocationId}:`, err);
    }
  }
  return { applied, failed };
}

export async function runBackfill(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const redis = createRedisClient({
    ...(args.redisUrl ? { url: args.redisUrl } : {}),
    ...(args.keyPrefix ? { keyPrefix: args.keyPrefix } : {}),
  });

  try {
    const invocationStore = new RedisInvocationRecordStore(redis);
    const messageStore = new RedisMessageStore(redis);

    if (!invocationStore.scanAll) {
      throw new Error('invocationStore.scanAll is not available — Redis store required');
    }

    console.log('[backfill-usage] scanning invocation records...');
    const invocations = await invocationStore.scanAll();
    console.log(`[backfill-usage]   ${invocations.length} invocation records found`);

    console.log('[backfill-usage] scanning messages...');
    const messages = await messageStore.scanAll();
    console.log(`[backfill-usage]   ${messages.length} messages found`);

    const messageIndex = indexMessagesByInvocation(messages);
    console.log(`[backfill-usage]   ${messageIndex.size} parent invocations referenced by usage-carrying messages`);

    const cutoffMs = Date.now() - args.days * 24 * 60 * 60 * 1000;
    const plan = planBackfill(invocations, messageIndex, { cutoffMs });

    console.log(formatBackfillPreview(plan, { dryRun: args.dryRun }));

    if (!args.dryRun) {
      console.log('[backfill-usage] applying writes...');
      const { applied, failed } = await applyPlan(plan, invocationStore);
      console.log(`[backfill-usage] applied: ${applied}, failed: ${failed}`);
      return failed === 0 ? 0 : 2;
    }
    console.log('[backfill-usage] DRY-RUN complete — re-run with --apply to write.');
    return 0;
  } finally {
    await redis.quit();
  }
}

async function main(): Promise<void> {
  try {
    const code = await runBackfill(process.argv.slice(2));
    if (code !== 0) process.exitCode = code;
  } catch (err) {
    console.error('[backfill-usage] failed:', err);
    process.exit(1);
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath.length > 0 && entryPath === fileURLToPath(import.meta.url)) {
  void main();
}
