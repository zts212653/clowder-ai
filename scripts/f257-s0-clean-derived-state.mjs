#!/usr/bin/env node

import crypto from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const DEFAULT_KEY_PREFIX = 'cat-cafe:';

const KEY = Object.freeze({
  pendingRun: 'harness-unit-run-pending:',
  snapshot: 'harness-evaluation-snapshot:',
  snapshotIndex: 'harness-evaluation-snapshot-index:',
  semanticResult: 'harness-unit-semantic-result:',
  unitJob: 'harness-unit-semantic-job:',
  unitReceipt: 'harness-unit-semantic-retrieval:',
  unitCompletion: 'harness-unit-semantic-completion:',
  sweepJob: 'harness-semantic-sweep-job:',
  sweepCompletion: 'harness-semantic-sweep-completion:',
  sweepState: 'harness-semantic-sweep-state:',
  sweepRetryDue: 'harness-semantic-sweep-retry-due',
});

const HELP = `Usage:
  node scripts/f257-s0-clean-derived-state.mjs --owner-user-id <id> [--redis-url <url>] [--key-prefix <prefix>]
  node scripts/f257-s0-clean-derived-state.mjs --owner-user-id <id> --apply --confirm-plan <sha256>

Safety:
  - REDIS_URL or --redis-url is required; this script never chooses a Redis target.
  - Dry-run is the default and prints every planned mutation.
  - Apply requires the exact plan digest printed by a fresh dry-run.
  - Only pending snapshots, legacy unit jobs, open sweep jobs, their derived outputs, and owner-scoped sweep drain state are targeted.
  - Completed judgments, completed sweep jobs, tracing, annotations, and override versions are never targeted.
`;

function readArg(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing_value:${flag}`);
  return value;
}

const VALUE_ARGS = Object.freeze({
  '--confirm-plan': 'confirmPlan',
  '--owner-user-id': 'ownerUserId',
  '--redis-url': 'redisUrl',
  '--key-prefix': 'keyPrefix',
});

function consumeArg(options, argv, index) {
  const arg = argv[index];
  if (arg === '--apply') options.apply = true;
  else if (arg === '--help' || arg === '-h') options.help = true;
  else {
    const optionKey = VALUE_ARGS[arg];
    if (!optionKey) throw new Error(`unknown_argument:${arg}`);
    options[optionKey] = readArg(argv, index, arg);
    return index + 1;
  }
  return index;
}

function validateArgs(options) {
  if (options.help) return;
  if (!options.redisUrl) throw new Error('redis_url_required');
  if (!options.ownerUserId) throw new Error('owner_user_id_required');
  if (options.apply && !options.confirmPlan) throw new Error('confirm_plan_required');
  if (!options.apply && options.confirmPlan) throw new Error('confirm_plan_requires_apply');
}

export function parseArgs(argv, env = process.env) {
  const options = {
    apply: false,
    confirmPlan: undefined,
    ownerUserId: undefined,
    redisUrl: env.REDIS_URL,
    keyPrefix: env.REDIS_KEY_PREFIX ?? DEFAULT_KEY_PREFIX,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    index = consumeArg(options, argv, index);
  }
  validateArgs(options);
  return options;
}

function escapeRedisGlob(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('*', '\\*').replaceAll('?', '\\?').replaceAll('[', '\\[');
}

async function scanAll(redis, pattern) {
  const keys = [];
  let cursor = '0';
  do {
    const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = String(result[0]);
    keys.push(...result[1]);
  } while (cursor !== '0');
  return [...new Set(keys)].sort();
}

async function readJson(redis, key) {
  const raw = await redis.get(key);
  if (raw === null) throw new Error(`key_changed_during_plan:${key}`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`invalid_json:${key}`);
  }
}

function requireIdentity(record, key, expectedJobId) {
  if (!record || typeof record !== 'object') throw new Error(`invalid_record:${key}`);
  if (record.jobId !== expectedJobId || typeof record.ownerUserId !== 'string') {
    throw new Error(`invalid_record:${key}`);
  }
}

function requirePendingIdentity(pending, key, ownerUserId, objectiveId) {
  if (
    !pending ||
    typeof pending !== 'object' ||
    typeof pending.snapshotId !== 'string' ||
    pending.snapshotId.length === 0 ||
    pending.snapshot?.ownerUserId !== ownerUserId ||
    pending.snapshot?.objectiveId !== objectiveId
  ) {
    throw new Error(`invalid_pending_run:${key}`);
  }
}

async function collectPendingState(context) {
  const { redis, ownerUserId, keyPrefix, addUnlink, addZrem } = context;
  const ownerPrefix = `${keyPrefix}${KEY.pendingRun}${ownerUserId}:`;
  const pendingKeys = await scanAll(redis, `${keyPrefix}${KEY.pendingRun}${escapeRedisGlob(ownerUserId)}:*`);
  for (const pendingKey of pendingKeys) {
    const pending = await readJson(redis, pendingKey);
    const objectiveId = pendingKey.slice(ownerPrefix.length);
    requirePendingIdentity(pending, pendingKey, ownerUserId, objectiveId);

    addUnlink(pendingKey, 'pending_run');
    const snapshotKey = `${keyPrefix}${KEY.snapshot}${pending.snapshotId}`;
    if ((await redis.exists(snapshotKey)) === 1) addUnlink(snapshotKey, 'pending_snapshot');

    const snapshotIndexKey = `${keyPrefix}${KEY.snapshotIndex}${ownerUserId}:${objectiveId}`;
    if ((await redis.zscore(snapshotIndexKey, pending.snapshotId)) !== null) {
      addZrem(snapshotIndexKey, pending.snapshotId, 'pending_snapshot_index');
    }

    const resultPattern = `${keyPrefix}${KEY.semanticResult}${escapeRedisGlob(pending.snapshotId)}:*`;
    for (const resultKey of await scanAll(redis, resultPattern)) addUnlink(resultKey, 'pending_semantic_result');
  }
}

async function collectUnitJobs(context) {
  const { redis, ownerUserId, keyPrefix, addUnlink } = context;
  const jobPrefix = `${keyPrefix}${KEY.unitJob}`;
  for (const jobKey of await scanAll(redis, `${jobPrefix}*`)) {
    const job = await readJson(redis, jobKey);
    const jobId = jobKey.slice(jobPrefix.length);
    requireIdentity(job, jobKey, jobId);
    if (job.ownerUserId !== ownerUserId) continue;

    addUnlink(jobKey, 'unit_job');
    const completionKey = `${keyPrefix}${KEY.unitCompletion}${jobId}`;
    if ((await redis.exists(completionKey)) === 1) addUnlink(completionKey, 'unit_completion');
    const receiptPattern = `${keyPrefix}${KEY.unitReceipt}${escapeRedisGlob(jobId)}:*`;
    for (const receiptKey of await scanAll(redis, receiptPattern)) addUnlink(receiptKey, 'unit_retrieval_receipt');
    if (typeof job.snapshotId === 'string' && job.snapshotId.length > 0) {
      const resultPattern = `${keyPrefix}${KEY.semanticResult}${escapeRedisGlob(job.snapshotId)}:*`;
      for (const resultKey of await scanAll(redis, resultPattern)) addUnlink(resultKey, 'pending_semantic_result');
    }
  }
}

async function collectOpenSweepJobs(context) {
  const { redis, ownerUserId, keyPrefix, addUnlink } = context;
  const jobPrefix = `${keyPrefix}${KEY.sweepJob}`;
  for (const jobKey of await scanAll(redis, `${jobPrefix}*`)) {
    const job = await readJson(redis, jobKey);
    const jobId = jobKey.slice(jobPrefix.length);
    requireIdentity(job, jobKey, jobId);
    if (job.ownerUserId !== ownerUserId) continue;
    const completionKey = `${keyPrefix}${KEY.sweepCompletion}${jobId}`;
    if ((await redis.exists(completionKey)) === 0) addUnlink(jobKey, 'open_sweep_job');
  }
}

async function collectSweepDrain(context) {
  const { redis, ownerUserId, keyPrefix, addUnlink, addZrem } = context;
  const sweepStateKey = `${keyPrefix}${KEY.sweepState}${ownerUserId}`;
  if ((await redis.exists(sweepStateKey)) === 1) addUnlink(sweepStateKey, 'sweep_drain_state');
  const sweepRetryKey = `${keyPrefix}${KEY.sweepRetryDue}`;
  if ((await redis.zscore(sweepRetryKey, ownerUserId)) !== null) {
    addZrem(sweepRetryKey, ownerUserId, 'sweep_retry_due');
  }
}

export async function buildCleanupPlan(
  redis,
  { ownerUserId, keyPrefix = DEFAULT_KEY_PREFIX, targetFingerprint = null },
) {
  const unlink = new Map();
  const zrem = new Map();
  const addUnlink = (key, category) => unlink.set(key, { key, category });
  const addZrem = (key, member, category) => zrem.set(`${key}\u0000${member}`, { key, member, category });
  const context = { redis, ownerUserId, keyPrefix, addUnlink, addZrem };
  await collectPendingState(context);
  await collectUnitJobs(context);
  await collectOpenSweepJobs(context);
  await collectSweepDrain(context);

  const unlinkKeys = [...unlink.values()].sort((left, right) => left.key.localeCompare(right.key));
  const zremMembers = [...zrem.values()].sort(
    (left, right) => left.key.localeCompare(right.key) || left.member.localeCompare(right.member),
  );
  const count = (category) => unlinkKeys.filter((entry) => entry.category === category).length;

  return {
    version: 1,
    ownerUserId,
    keyPrefix,
    targetFingerprint,
    counts: {
      pendingRuns: count('pending_run'),
      pendingSnapshots: count('pending_snapshot'),
      pendingSemanticResults: count('pending_semantic_result'),
      unitJobs: count('unit_job'),
      unitRetrievalReceipts: count('unit_retrieval_receipt'),
      unitCompletions: count('unit_completion'),
      openSweepJobs: count('open_sweep_job'),
      sweepDrainStates: count('sweep_drain_state'),
      indexMembers: zremMembers.length,
    },
    unlinkKeys,
    zremMembers,
  };
}

export function cleanupPlanDigest(plan) {
  const canonical = JSON.stringify({
    version: plan.version,
    ownerUserId: plan.ownerUserId,
    keyPrefix: plan.keyPrefix,
    targetFingerprint: plan.targetFingerprint,
    unlinkKeys: plan.unlinkKeys,
    zremMembers: plan.zremMembers,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Apply a confirmed cleanup plan.
 *
 * The confirmed digest is a compare-and-set token against live Redis, not a
 * checksum of the object handed in. A plan is re-derived here and the caller's
 * digest must still describe that live derivation, so state that moved after
 * planning — a sweep job that completed, a pending run that was consumed —
 * aborts the apply instead of unlinking a record whose sibling now outlives it.
 * Mutations are issued from the live derivation, never from the passed plan.
 */
export async function applyCleanupPlan(redis, plan, confirmedDigest) {
  const actualDigest = cleanupPlanDigest(plan);
  if (confirmedDigest !== actualDigest) throw new Error(`cleanup_plan_digest_mismatch:${actualDigest}`);

  const live = await buildCleanupPlan(redis, {
    ownerUserId: plan.ownerUserId,
    keyPrefix: plan.keyPrefix,
    targetFingerprint: plan.targetFingerprint,
  });
  const liveDigest = cleanupPlanDigest(live);
  if (liveDigest !== confirmedDigest) throw new Error(`cleanup_plan_state_changed:${liveDigest}`);

  const transaction = redis.multi();
  for (const entry of live.unlinkKeys) transaction.unlink(entry.key);
  for (const entry of live.zremMembers) transaction.zrem(entry.key, entry.member);
  const result = await transaction.exec();
  const failure = result?.find(([error]) => error);
  if (failure) throw failure[0];
  return { unlinked: live.unlinkKeys.length, indexMembersRemoved: live.zremMembers.length };
}

function safeRedisTarget(redisUrl) {
  const parsed = new URL(redisUrl);
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}

function redisTargetFingerprint(redisUrl) {
  return crypto.createHash('sha256').update(safeRedisTarget(redisUrl)).digest('hex');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(options.redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true });
  try {
    await redis.connect();
    const plan = await buildCleanupPlan(redis, {
      ...options,
      targetFingerprint: redisTargetFingerprint(options.redisUrl),
    });
    const planDigest = cleanupPlanDigest(plan);
    console.log(
      JSON.stringify(
        {
          mode: options.apply ? 'apply' : 'dry-run',
          redisTarget: safeRedisTarget(options.redisUrl),
          planDigest,
          ...plan,
        },
        null,
        2,
      ),
    );
    if (!options.apply) return;
    const applied = await applyCleanupPlan(redis, plan, options.confirmPlan);
    console.log(JSON.stringify({ status: 'applied', planDigest, ...applied }));
  } finally {
    await redis.quit();
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
