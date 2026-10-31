import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import { parseStoredCandidate } from '../../domains/memory/people/person-memory-records.js';

const KEY_PREFIX = 'cat-cafe:';
const CANDIDATE_PATTERN = `${KEY_PREFIX}person-memory:candidate:*`;
const PRODUCTION_CONFIRMATION = 'BACKFILL F276 HISTORY TO 6399';

interface CliArgs {
  redisUrl: string;
  apply: boolean;
  confirm?: string;
}

interface BackfillRedis {
  scan(
    cursor: string | number,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]>;
  get(key: string): Promise<string | null>;
  zscore(key: string, member: string): Promise<string | null>;
  zadd(key: string, score: number, member: string): Promise<number>;
}

interface BackfillEntry {
  candidateId: string;
  ownerUserId: string;
  state: 'materialized' | 'rejected';
  decidedAt: number;
  settledKey: string;
}

interface BackfillSummary {
  scanned: number;
  eligible: number;
  alreadyIndexed: number;
  missing: BackfillEntry[];
  applied: number;
}

function encodePart(value: string): string {
  return encodeURIComponent(value);
}

function settledKey(ownerUserId: string): string {
  return `${KEY_PREFIX}person-memory:settled:${encodePart(ownerUserId)}`;
}

function suppressionKey(ownerUserId: string, candidateId: string): string {
  return `${KEY_PREFIX}person-memory:suppression:${encodePart(ownerUserId)}:${encodePart(candidateId)}`;
}

function parseCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const args: CliArgs = { redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6398', apply: false };
  const valueFields = new Map<string, 'redisUrl' | 'confirm'>([
    ['--redis-url', 'redisUrl'],
    ['--confirm', 'confirm'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      args.apply = true;
      continue;
    }
    if (arg === '--' || arg === '--dry-run') continue;
    const field = valueFields.get(arg);
    if (!field) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    args[field] = value;
    index += 1;
  }
  return args;
}

function assertSafeTarget(args: CliArgs): void {
  const target = new URL(args.redisUrl);
  if (target.hostname !== '127.0.0.1' && target.hostname !== 'localhost') {
    throw new Error(`F276 history backfill only supports loopback Redis, got ${target.hostname}`);
  }
  const port = target.port || '6379';
  if (port !== '6398' && port !== '6399') {
    throw new Error(`F276 history backfill only supports preview 6398 or runtime 6399, got ${port}`);
  }
  if (args.apply && port === '6399' && args.confirm !== PRODUCTION_CONFIRMATION) {
    throw new Error(`Runtime Redis 6399 apply requires --confirm "${PRODUCTION_CONFIRMATION}"`);
  }
}

function finiteTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

async function terminalEntry(redis: BackfillRedis, raw: string): Promise<BackfillEntry | null> {
  const candidate = parseStoredCandidate(raw);
  if (!candidate || candidate.publication.state !== 'anchored') return null;
  let decidedAt: number | null = null;
  if (candidate.state === 'materialized') {
    decidedAt = finiteTimestamp(candidate.latestDecisionReceipt?.decidedAt);
  } else if (candidate.state === 'rejected') {
    decidedAt = finiteTimestamp(candidate.humanDispositionLedgerEntry?.episode.decidedAt);
    if (decidedAt === null) {
      const suppressionRaw = await redis.get(suppressionKey(candidate.ownerUserId, candidate.candidateId));
      if (suppressionRaw) {
        try {
          decidedAt = finiteTimestamp((JSON.parse(suppressionRaw) as { createdAt?: unknown }).createdAt);
        } catch {
          decidedAt = null;
        }
      }
    }
  } else {
    return null;
  }
  if (decidedAt === null) return null;
  return {
    candidateId: candidate.candidateId,
    ownerUserId: candidate.ownerUserId,
    state: candidate.state,
    decidedAt,
    settledKey: settledKey(candidate.ownerUserId),
  };
}

async function runBackfill(redis: BackfillRedis, apply: boolean): Promise<BackfillSummary> {
  const summary: BackfillSummary = { scanned: 0, eligible: 0, alreadyIndexed: 0, missing: [], applied: 0 };
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', CANDIDATE_PATTERN, 'COUNT', 100);
    cursor = nextCursor;
    for (const key of keys) {
      summary.scanned += 1;
      const raw = await redis.get(key);
      if (!raw) continue;
      const entry = await terminalEntry(redis, raw);
      if (!entry) continue;
      summary.eligible += 1;
      if ((await redis.zscore(entry.settledKey, entry.candidateId)) !== null) {
        summary.alreadyIndexed += 1;
        continue;
      }
      summary.missing.push(entry);
      if (apply) {
        await redis.zadd(entry.settledKey, entry.decidedAt, entry.candidateId);
        summary.applied += 1;
      }
    }
  } while (cursor !== '0');
  return summary;
}

function safeTargetLabel(redisUrl: string): string {
  const target = new URL(redisUrl);
  return `${target.hostname}:${target.port || '6379'}${target.pathname || '/'}`;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  assertSafeTarget(args);
  const redis = new Redis(args.redisUrl, { maxRetriesPerRequest: 3 });
  try {
    await redis.ping();
    const summary = await runBackfill(redis, args.apply);
    process.stdout.write(
      `${JSON.stringify({ mode: args.apply ? 'apply' : 'dry-run', target: safeTargetLabel(args.redisUrl), ...summary }, null, 2)}\n`,
    );
  } finally {
    await redis.quit();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[f276-history-backfill] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { PRODUCTION_CONFIRMATION, assertSafeTarget, parseCliArgs, runBackfill, terminalEntry };
