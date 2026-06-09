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
  decideApplyOutcome,
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

/** Read the next argv slot as a value for a `--name <value>` style flag. */
function readValue(argv: readonly string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseDays(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--days requires a positive integer, got: ${value}`);
  }
  return parsed;
}

interface MutableCliArgs {
  dryRun: boolean;
  days: number;
  redisUrl?: string;
  keyPrefix?: string;
  help: boolean;
}

/** Apply a single argv token to the in-progress CliArgs accumulator.
 *  Returns the number of slots consumed (1 for boolean flags, 2 for value flags). */
function applyArg(argv: readonly string[], i: number, out: MutableCliArgs): number {
  const arg = argv[i];
  switch (arg) {
    case '--apply':
      out.dryRun = false;
      return 1;
    case '--dry-run':
      out.dryRun = true;
      return 1;
    case '--help':
    case '-h':
      out.help = true;
      return 1;
    case '--days':
      out.days = parseDays(readValue(argv, i, '--days'));
      return 2;
    case '--redis-url':
      out.redisUrl = readValue(argv, i, '--redis-url');
      return 2;
    case '--key-prefix':
      out.keyPrefix = readValue(argv, i, '--key-prefix');
      return 2;
    default:
      throw new Error(`unknown argument: ${arg}`);
  }
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: MutableCliArgs = { dryRun: true, days: 30, help: false };
  for (let i = 0; i < argv.length; i += applyArg(argv, i, out)) {
    // applyArg advances i — body intentionally empty
  }
  return {
    dryRun: out.dryRun,
    days: out.days,
    ...(out.redisUrl ? { redisUrl: out.redisUrl } : {}),
    ...(out.keyPrefix ? { keyPrefix: out.keyPrefix } : {}),
    help: out.help,
  };
}

export interface ApplyStats {
  applied: number;
  skippedMissing: number;
  skippedStatus: number;
  skippedPopulated: number;
  skippedCas: number;
  failed: number;
}

export async function applyPlan(
  plan: BackfillPlan,
  store: Pick<RedisInvocationRecordStore, 'get' | 'update'>,
): Promise<ApplyStats> {
  // 砚砚 cloud review P1-B: never overwrite a usageByCat that arrived between
  // the planning scan and this loop. For each entry we (a) re-read the current
  // record, (b) run the pure decideApplyOutcome predicate, and (c) pass both
  // expectedStatus='succeeded' and expectedUsageByCatAbsent=true so the store's
  // atomic update guards the narrow window between our re-read and write.
  const stats: ApplyStats = {
    applied: 0,
    skippedMissing: 0,
    skippedStatus: 0,
    skippedPopulated: 0,
    skippedCas: 0,
    failed: 0,
  };
  for (const entry of plan.entries) {
    try {
      const current = await store.get(entry.invocationId);
      const decision = decideApplyOutcome(entry, current);
      if (decision.kind === 'skip-missing') {
        stats.skippedMissing += 1;
        console.warn(`[backfill-usage] skip ${entry.invocationId}: ${decision.reason}`);
        continue;
      }
      if (decision.kind === 'skip-status') {
        stats.skippedStatus += 1;
        console.warn(`[backfill-usage] skip ${entry.invocationId}: ${decision.reason}`);
        continue;
      }
      if (decision.kind === 'skip-populated') {
        stats.skippedPopulated += 1;
        console.warn(`[backfill-usage] skip ${entry.invocationId}: ${decision.reason}`);
        continue;
      }
      const updated = await store.update(entry.invocationId, {
        usageByCat: entry.usageByCat,
        usageRecordedAt: entry.usageRecordedAt,
        // CAS — fail closed if status flipped between our re-read and the store's
        // atomic Lua transaction, or if usageByCat was populated by a concurrent
        // writer. Better to leave the record alone than clobber live usage.
        expectedStatus: 'succeeded',
        expectedUsageByCatAbsent: true,
      });
      if (updated) {
        stats.applied += 1;
      } else {
        stats.skippedCas += 1;
        console.warn(
          `[backfill-usage] skip ${entry.invocationId}: update returned null ` +
            '(CAS mismatch — status changed or usageByCat populated during apply)',
        );
      }
    } catch (err) {
      stats.failed += 1;
      console.error(`[backfill-usage] update failed for ${entry.invocationId}:`, err);
    }
  }
  return stats;
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
      const stats = await applyPlan(plan, invocationStore);
      console.log(
        `[backfill-usage] applied: ${stats.applied}, ` +
          `skipped(missing): ${stats.skippedMissing}, ` +
          `skipped(status): ${stats.skippedStatus}, ` +
          `skipped(populated): ${stats.skippedPopulated}, ` +
          `skipped(cas): ${stats.skippedCas}, ` +
          `failed: ${stats.failed}`,
      );
      return stats.failed === 0 ? 0 : 2;
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
