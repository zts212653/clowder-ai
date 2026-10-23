/**
 * Prepare persisted runtime interactions for a rollback to a revision whose
 * question schema predates `multiSelect` / `allowUnanswered`.
 *
 * Why: the previous strict reader rejects unknown question fields. Settling
 * pending cards alone is not enough — terminal/history records retain the
 * request JSON and become unreadable after a downgrade. This command rewrites
 * every stored question request into the frozen pre-Phase-C shape, and
 * invalidates cards that were still pending so the old host cannot show a
 * degraded (single-select / required-answer) version of them.
 *
 * Run with the API host stopped. Default is a zero-write dry-run.
 *
 *   pnpm --filter @cat-cafe/api run downgrade:runtime-interaction -- --redis-url <url>
 *   pnpm --filter @cat-cafe/api run downgrade:runtime-interaction -- --redis-url <url> \
 *     --apply --confirm "PREPARE RUNTIME INTERACTION DOWNGRADE"
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import { legacyRuntimeQuestionRequestSchema } from './runtime-interaction-downgrade/legacy-question-schema.js';

const DEFAULT_KEY_PREFIX = 'cat-cafe:';
const SCAN_COUNT = 200;

/** The only terminal reason this tool ever wrote (`9a94ea182` onward). */
const DOWNGRADE_REASON_CODE = 'host_restarted';
/**
 * Proof that this tool's own settlement committed: written in the same MULTI
 * as the terminal/revision, and removed together with the request rewrite.
 * The host's Lua settlement is atomic, so every other writer needs no marker.
 */
const SETTLED_REVISION_FIELD = 'downgradeSettledRevision';

export const APPLY_CONFIRMATION = 'PREPARE RUNTIME INTERACTION DOWNGRADE';

export interface DowngradeCliArgs {
  redisUrl: string;
  keyPrefix: string;
  apply: boolean;
  runtimeRedisAcknowledged: boolean;
  confirm?: string;
  now: number;
}

/** ioredis resolves EXEC with one `[error, result]` entry per queued command. */
export type DowngradeExecReply = Array<[Error | null, unknown]> | null;

export interface DowngradeTransaction {
  hset(key: string, field: string, value: string): DowngradeTransaction;
  hdel(key: string, field: string): DowngradeTransaction;
  zrem(key: string, member: string): DowngradeTransaction;
  srem(key: string, member: string): DowngradeTransaction;
  exec(): Promise<DowngradeExecReply>;
}

export interface DowngradeRedis {
  scan(cursor: string, ...args: Array<string | number>): Promise<[string, string[]]>;
  type(key: string): Promise<string>;
  hgetall(key: string): Promise<Record<string, string>>;
  hset(key: string, field: string, value: string): Promise<number>;
  hdel(key: string, field: string): Promise<number>;
  zrem(key: string, member: string): Promise<number>;
  srem(key: string, member: string): Promise<number>;
  multi(): DowngradeTransaction;
}

export interface DowngradeFailure {
  key: string;
  interactionId: string | null;
  reason: string;
}

export interface DowngradeSummary {
  scanned: number;
  interactionHashes: number;
  questionRecords: number;
  rewritable: number;
  pendingSettled: number;
  recovered: number;
  rewritten: number;
  untouched: number;
  invalid: number;
  failures: DowngradeFailure[];
}

type RecordAction =
  | { kind: 'untouched'; reason: 'not_question' | 'no_new_fields' }
  | {
      kind: 'rewrite';
      key: string;
      interactionId: string;
      ownerUserId: string;
      invocationId: string;
      status: string;
      revision: number;
      updatedAt: string | undefined;
      submissionPresent: boolean;
      settledRevision: number | undefined;
      terminal: StoredTerminalRead;
      request: Record<string, unknown>;
    }
  | { kind: 'invalid'; interactionId: string | null; reason: string };

interface StoredTerminal {
  status: string;
  reasonCode: string | null;
  settledAt: number;
}

type StoredTerminalRead = { kind: 'absent' } | { kind: 'unreadable' } | { kind: 'parsed'; terminal: StoredTerminal };

type SettlementPlanDescriptor =
  | { kind: 'rewrite'; settledAt: number }
  | { kind: 'finish'; settledAt: number }
  | { kind: 'complete' };

/**
 * Settlement completeness, not terminal presence.
 *
 * The previous host wrote `status`, `terminal`, `updatedAt`, `revision` and the
 * `submission` removal as separate commands. A stop between them leaves a
 * nonempty terminal beside stale bookkeeping, so a terminal alone cannot prove
 * the invalidation finished — and with no `submission` on a normal pending
 * question there is nothing left to tell a finished write from a stop before
 * the revision bump. Completeness therefore needs positive proof:
 *
 * 1. this tool's own settlement marker still matching the stored revision, or
 * 2. a terminal reason the downgrade runner never wrote — every host
 *    settlement is a Lua script that writes terminal/updatedAt/revision in one
 *    step, so its revision bump cannot be missing.
 *
 * Anything else is finished here under the settlement time already recorded in
 * that terminal, which bumps the revision past the pending value.
 */
function readStoredTerminal(value: string | undefined): StoredTerminalRead {
  if (value === undefined || value.length === 0) return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { kind: 'unreadable' };
  }
  if (!isRecord(parsed)) return { kind: 'unreadable' };
  const { status, reasonCode, settledAt } = parsed;
  if (typeof status !== 'string' || typeof settledAt !== 'number' || !Number.isFinite(settledAt)) {
    return { kind: 'unreadable' };
  }
  return {
    kind: 'parsed',
    terminal: { status, reasonCode: typeof reasonCode === 'string' ? reasonCode : null, settledAt },
  };
}

function planSettlement(action: Extract<RecordAction, { kind: 'rewrite' }>, now: number): SettlementPlanDescriptor {
  const read = action.terminal;
  if (read.kind !== 'parsed' || read.terminal.status !== action.status) return { kind: 'rewrite', settledAt: now };
  const terminal = read.terminal;
  // A matching marker proves the revision write, not every command in that
  // transaction: Redis still applies the other commands when one is rejected.
  // It may only skip the settlement when the metadata it wrote is all there.
  const metadataComplete = action.updatedAt === String(terminal.settledAt) && !action.submissionPresent;
  if (metadataComplete && action.settledRevision === action.revision) return { kind: 'complete' };
  if (terminal.reasonCode === DOWNGRADE_REASON_CODE) return { kind: 'finish', settledAt: terminal.settledAt };
  return metadataComplete ? { kind: 'complete' } : { kind: 'finish', settledAt: terminal.settledAt };
}

function assignArgValue(
  args: DowngradeCliArgs,
  field: 'redisUrl' | 'keyPrefix' | 'confirm' | 'now',
  flag: string,
  value: string,
): void {
  if (field === 'now') {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} requires a non-negative integer`);
    args.now = parsed;
    return;
  }
  args[field] = value;
}

export function parseCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): DowngradeCliArgs {
  const args: DowngradeCliArgs = {
    redisUrl: '',
    keyPrefix: env.REDIS_KEY_PREFIX ?? DEFAULT_KEY_PREFIX,
    apply: false,
    runtimeRedisAcknowledged: false,
    now: Date.now(),
  };
  const valueFields = new Map<string, 'redisUrl' | 'keyPrefix' | 'confirm' | 'now'>([
    ['--redis-url', 'redisUrl'],
    ['--key-prefix', 'keyPrefix'],
    ['--confirm', 'confirm'],
    ['--now', 'now'],
  ]);
  const booleanFields = new Map<string, 'apply' | 'runtimeRedisAcknowledged'>([
    ['--apply', 'apply'],
    ['--i-understand-runtime-redis', 'runtimeRedisAcknowledged'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--' || arg === '--dry-run') continue;
    const booleanField = booleanFields.get(arg);
    if (booleanField) {
      args[booleanField] = true;
      continue;
    }
    const field = valueFields.get(arg);
    if (!field) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    assignArgValue(args, field, arg, value);
    index += 1;
  }
  if (!args.redisUrl.trim()) throw new Error('Explicit --redis-url <url> is required; REDIS_URL is not used');
  args.keyPrefix = args.keyPrefix === '' || args.keyPrefix.endsWith(':') ? args.keyPrefix : `${args.keyPrefix}:`;
  return args;
}

/** Pure target guard: no client may be created before this check, including dry-run. */
export function assertRedisTarget(args: Pick<DowngradeCliArgs, 'redisUrl' | 'runtimeRedisAcknowledged'>): void {
  const target = new URL(args.redisUrl);
  if (!['redis:', 'rediss:', 'unix:'].includes(target.protocol)) {
    throw new Error('--redis-url must use redis://, rediss:// or unix://');
  }
  if (Number(target.port) === 6399 && !args.runtimeRedisAcknowledged) {
    throw new Error('Redis 6399 requires prior owner authorization and --i-understand-runtime-redis');
  }
}

export function assertApplyConfirmation(args: DowngradeCliArgs): void {
  assertRedisTarget(args);
  if (args.apply && args.confirm !== APPLY_CONFIRMATION) {
    throw new Error(`--apply requires --confirm "${APPLY_CONFIRMATION}"`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : undefined;
}

function stripQuestionFields(request: Record<string, unknown>): {
  request: Record<string, unknown>;
  changed: boolean;
} {
  const questions = request.questions;
  if (!Array.isArray(questions)) return { request, changed: false };
  let changed = false;
  const stripped = questions.map((question) => {
    if (!isRecord(question)) return question;
    if (!Object.hasOwn(question, 'multiSelect') && !Object.hasOwn(question, 'allowUnanswered')) return question;
    changed = true;
    const next = { ...question };
    delete next.multiSelect;
    delete next.allowUnanswered;
    return next;
  });
  return changed ? { request: { ...request, questions: stripped }, changed } : { request, changed };
}

function describeIssues(error: { issues: Array<{ path: Array<string | number>; message: string }> }): string {
  const issue = error.issues[0];
  if (!issue) return 'legacy schema rejected the rewritten request';
  const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
  return `${path}: ${issue.message}`;
}

export function inspectStoredRecord(key: string, raw: Record<string, string>, keyPrefix: string): RecordAction {
  if (!raw.request) return { kind: 'invalid', interactionId: null, reason: 'missing request field' };
  let request: unknown;
  try {
    request = JSON.parse(raw.request);
  } catch {
    return { kind: 'invalid', interactionId: null, reason: 'request is not valid JSON' };
  }
  if (!isRecord(request)) return { kind: 'invalid', interactionId: null, reason: 'request is not an object' };
  if (request.kind !== 'question') return { kind: 'untouched', reason: 'not_question' };
  const interactionId = typeof request.interactionId === 'string' ? request.interactionId : null;
  if (!interactionId) return { kind: 'invalid', interactionId: null, reason: 'missing interactionId' };
  if (key !== `${keyPrefix}runtime-interaction:${interactionId}`) {
    return { kind: 'invalid', interactionId, reason: 'detail key does not match interactionId' };
  }
  const { request: rewritten, changed } = stripQuestionFields(request);
  if (!changed) return { kind: 'untouched', reason: 'no_new_fields' };

  const validation = legacyRuntimeQuestionRequestSchema.safeParse(rewritten);
  if (!validation.success) {
    return { kind: 'invalid', interactionId, reason: describeIssues(validation.error) };
  }
  const owner = rewritten.owner;
  if (!isRecord(owner) || typeof owner.userId !== 'string' || typeof owner.invocationId !== 'string') {
    return { kind: 'invalid', interactionId, reason: 'missing owner identity' };
  }
  const revision = readPositiveInteger(raw.revision) ?? 1;
  return {
    kind: 'rewrite',
    key,
    interactionId,
    ownerUserId: owner.userId,
    invocationId: owner.invocationId,
    status: raw.status ?? 'unknown',
    revision,
    updatedAt: raw.updatedAt,
    submissionPresent: Object.hasOwn(raw, 'submission'),
    settledRevision: readPositiveInteger(raw[SETTLED_REVISION_FIELD]),
    terminal: readStoredTerminal(raw.terminal),
    // Write the stripped source, not the zod output: `nonBlank` trims, and a
    // downgrade must not rewrite human-authored text beyond removing the two
    // unsupported fields.
    request: rewritten,
  };
}

function queueSettlement(
  tx: DowngradeTransaction,
  action: Extract<RecordAction, { kind: 'rewrite' }>,
  keyPrefix: string,
  plan: SettlementPlanDescriptor,
): void {
  if (plan.kind === 'rewrite') {
    const terminal = { status: 'invalidated', reasonCode: DOWNGRADE_REASON_CODE, settledAt: plan.settledAt };
    tx.hset(action.key, 'status', 'invalidated');
    tx.hset(action.key, 'terminal', JSON.stringify(terminal));
    tx.hset(action.key, 'updatedAt', String(plan.settledAt));
    tx.hset(action.key, 'revision', String(action.revision + 1));
    tx.hdel(action.key, 'submission');
  } else if (plan.kind === 'finish') {
    // Finish the interrupted settlement under its own recorded time instead of
    // starting a new one; the terminal and its status stay as recorded. Every
    // pre-settlement revision is lower than this bump, whatever write the old
    // runner stopped at, and a repeated run is a no-op because the marker then
    // proves the settlement completed.
    tx.hset(action.key, 'updatedAt', String(plan.settledAt));
    tx.hset(action.key, 'revision', String(action.revision + 1));
    tx.hdel(action.key, 'submission');
  }
  if (plan.kind !== 'complete') tx.hset(action.key, SETTLED_REVISION_FIELD, String(action.revision + 1));
  // Index cleanup is idempotent. Replaying a run that was interrupted before
  // the request rewrite must still remove stale memberships.
  tx.zrem(`${keyPrefix}runtime-interaction:user:${action.ownerUserId}:pending`, action.interactionId);
  tx.srem(`${keyPrefix}runtime-interaction:active`, action.interactionId);
  tx.srem(`${keyPrefix}runtime-interaction:invocation:${action.invocationId}:active`, action.interactionId);
}

/**
 * ZREM/SREM against a key of the wrong type returns WRONGTYPE while the rest of
 * the transaction still commits, which would strip the detection fields with
 * cleanup still pending. Check the index types first and refuse the record
 * instead of guessing.
 */
async function indexTypeProblem(
  redis: DowngradeRedis,
  action: Extract<RecordAction, { kind: 'rewrite' }>,
  keyPrefix: string,
): Promise<string | null> {
  const expected: Array<[string, string]> = [
    [`${keyPrefix}runtime-interaction:user:${action.ownerUserId}:pending`, 'zset'],
    [`${keyPrefix}runtime-interaction:active`, 'set'],
    [`${keyPrefix}runtime-interaction:invocation:${action.invocationId}:active`, 'set'],
  ];
  for (const [key, type] of expected) {
    const actual = await redis.type(key);
    if (actual !== 'none' && actual !== type) return `${key} has type ${actual}; expected ${type}`;
  }
  return null;
}

/** EXEC resolves per-command errors instead of rejecting; the receipt must not hide them. */
function describeExecFailure(replies: DowngradeExecReply): string | null {
  if (replies === null) return 'transaction aborted before EXEC';
  for (const [index, reply] of replies.entries()) {
    const error = reply instanceof Error ? reply : Array.isArray(reply) ? reply[0] : null;
    if (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return `EXEC command ${index + 1} failed: ${reason}`;
    }
  }
  return null;
}

/**
 * The request rewrite is the commit point: it removes the fields this tool
 * detects records by, so it must be the last write, and an interruption before
 * it leaves a record a later run can still find and finish. The settlement
 * marker goes with it in one step, so it never outlives the downgrade.
 */
async function commitRewrite(redis: DowngradeRedis, action: Extract<RecordAction, { kind: 'rewrite' }>): Promise<void> {
  const tx = redis.multi();
  tx.hset(action.key, 'request', JSON.stringify(action.request));
  tx.hdel(action.key, SETTLED_REVISION_FIELD);
  const failure = describeExecFailure(await tx.exec());
  if (failure) throw new Error(failure);
}

async function settleAndRewrite(
  redis: DowngradeRedis,
  action: Extract<RecordAction, { kind: 'rewrite' }>,
  keyPrefix: string,
  now: number,
): Promise<void> {
  const blocked = await indexTypeProblem(redis, action, keyPrefix);
  if (blocked) throw new Error(blocked);
  const tx = redis.multi();
  queueSettlement(tx, action, keyPrefix, planSettlement(action, now));
  const failure = describeExecFailure(await tx.exec());
  if (failure) throw new Error(failure);
  await commitRewrite(redis, action);
}

async function handleInteractionRecord(
  redis: DowngradeRedis,
  key: string,
  args: Pick<DowngradeCliArgs, 'apply' | 'keyPrefix' | 'now'>,
  summary: DowngradeSummary,
): Promise<void> {
  const action = inspectStoredRecord(key, await redis.hgetall(key), args.keyPrefix);
  if (action.kind === 'invalid') {
    summary.invalid += 1;
    summary.failures.push({ key, interactionId: action.interactionId, reason: action.reason });
    return;
  }
  if (action.kind === 'untouched') {
    if (action.reason === 'no_new_fields') summary.questionRecords += 1;
    summary.untouched += 1;
    return;
  }
  summary.questionRecords += 1;
  summary.rewritable += 1;
  const settle = action.status === 'staged' || action.status === 'pending';
  const recover = action.status === 'invalidated';
  if (settle) summary.pendingSettled += 1;
  if (recover) summary.recovered += 1;
  if (!args.apply) return;
  try {
    if (settle || recover) {
      // Settlement and index cleanup commit together; the request rewrite is the
      // last write, so an interrupted run leaves a record that still carries the
      // detection fields and a replay can finish it — never a partial receipt.
      await settleAndRewrite(redis, action, args.keyPrefix, args.now);
    } else {
      await commitRewrite(redis, action);
    }
  } catch (error) {
    // Report the record instead of aborting the scan; a run that could not
    // finish must not print a successful downgrade receipt.
    summary.failures.push({
      key,
      interactionId: action.interactionId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  summary.rewritten += 1;
}

export async function runDowngrade(
  redis: DowngradeRedis,
  args: Pick<DowngradeCliArgs, 'apply' | 'keyPrefix' | 'now'>,
): Promise<DowngradeSummary> {
  const summary: DowngradeSummary = {
    scanned: 0,
    interactionHashes: 0,
    questionRecords: 0,
    rewritable: 0,
    pendingSettled: 0,
    recovered: 0,
    rewritten: 0,
    untouched: 0,
    invalid: 0,
    failures: [],
  };
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${args.keyPrefix}runtime-interaction:*`,
      'COUNT',
      SCAN_COUNT,
    );
    cursor = nextCursor;
    for (const key of keys) {
      summary.scanned += 1;
      if ((await redis.type(key)) !== 'hash') continue;
      summary.interactionHashes += 1;
      await handleInteractionRecord(redis, key, args, summary);
    }
  } while (cursor !== '0');
  return summary;
}

function safeTargetLabel(redisUrl: string): string {
  const target = new URL(redisUrl);
  return `${target.hostname}:${target.port || '6379'}${target.pathname || '/'}`;
}

const CLI_USAGE = `Usage:
  pnpm --filter @cat-cafe/api downgrade:runtime-interaction -- [options]

Default mode is a zero-write dry-run. Stop the API host before --apply.

Options:
  --redis-url <url>      Required explicit Redis target; no default or REDIS_URL fallback
  --i-understand-runtime-redis  Required for port 6399, after prior owner authorization
  --key-prefix <prefix>  Redis key prefix (default: REDIS_KEY_PREFIX or cat-cafe:)
  --now <ms>             Settlement timestamp for deterministic runs (default: now)
  --apply                Rewrite records and invalidate pending cards
  --confirm <text>       Required with --apply: "${APPLY_CONFIRMATION}"
  --help                 Show this message
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    process.stdout.write(CLI_USAGE);
    return;
  }
  const args = parseCliArgs(argv);
  assertApplyConfirmation(args);
  const redis = new Redis(args.redisUrl, { maxRetriesPerRequest: 3 });
  try {
    await redis.ping();
    const summary = await runDowngrade(redis as unknown as DowngradeRedis, args);
    process.stdout.write(
      `${JSON.stringify(
        { mode: args.apply ? 'apply' : 'dry-run', target: safeTargetLabel(args.redisUrl), ...summary },
        null,
        2,
      )}\n`,
    );
    if (summary.failures.length > 0) process.exitCode = 1;
  } finally {
    await redis.quit();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[runtime-interaction-downgrade] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
