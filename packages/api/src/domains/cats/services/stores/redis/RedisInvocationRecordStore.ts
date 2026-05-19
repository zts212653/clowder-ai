/**
 * Redis InvocationRecord Store
 * Redis-backed invocation record storage with Lua atomic create.
 *
 * ADR-008 D1+D2: Lua 脚本原子创建 — 幂等 key 占位 + Record 创建在同一 EVAL 中。
 *
 * IMPORTANT: ioredis keyPrefix auto-prefixes ALL commands including eval() KEYS[].
 * Do NOT manually prepend the prefix — pass bare keys and let ioredis handle it.
 */

import type { CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { TokenUsage } from '../../types.js';
import type {
  CreateInvocationInput,
  CreateResult,
  IInvocationRecordStore,
  InvocationRecord,
  InvocationStatus,
  UpdateInvocationInput,
} from '../ports/InvocationRecordStore.js';
import { InvocationKeys } from '../redis-keys/invocation-keys.js';

const DEFAULT_TTL_SECONDS = 0; // persistent — set >0 via env to enable expiry
const IDEMPOTENCY_TTL_SECONDS = 300; // 5 minutes

/**
 * Lua script for atomic idempotency check + record creation.
 * KEYS[1] = idempotency key (ioredis auto-prefixes)
 * KEYS[2] = invocation record key (ioredis auto-prefixes)
 * ARGV[1..7] = id, threadId, userId, targetCats(JSON), intent, idempotencyKey, now
 */
const CREATE_ATOMIC_LUA = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return {'duplicate', existing}
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ${IDEMPOTENCY_TTL_SECONDS})
redis.call('HSET', KEYS[2],
  'id', ARGV[1], 'threadId', ARGV[2], 'userId', ARGV[3],
  'targetCats', ARGV[4], 'intent', ARGV[5],
  'idempotencyKey', ARGV[6], 'status', 'queued',
  'userMessageId', '', 'error', '',
  'createdAt', ARGV[7], 'updatedAt', ARGV[7])
${DEFAULT_TTL_SECONDS > 0 ? `redis.call('EXPIRE', KEYS[2], ${DEFAULT_TTL_SECONDS})` : '-- persistent mode: no EXPIRE'}
return {'created', ARGV[1]}
`;

/**
 * Lua script for atomic status update with state machine guard.
 * Handles both CAS (expectedStatus provided) and non-CAS paths atomically.
 *
 * F194 Phase B (R3 P1 fix): set membership maintenance is now INSIDE this script —
 * post-Lua best-effort SADD/SREM had a race where a process crash between status
 * update and Set update would leave a record `running` but missing from the index,
 * silently re-introducing split-brain. Atomic Lua eliminates that window.
 *
 * KEYS[1] = invocation record hash key
 * KEYS[2] = running set key (invoc:running:{threadId}:{userId}) — derived from JS-side
 *          snapshot of (threadId, userId); guarded inside Lua via ARGV[3]/ARGV[4]
 * ARGV[1] = expectedStatus ("" if non-CAS)
 * ARGV[2] = newStatus ("" if no status change)
 * ARGV[3] = expectedThreadId (matches snapshot used to derive KEYS[2])
 * ARGV[4] = expectedUserId (matches snapshot used to derive KEYS[2])
 * ARGV[5..N] = field/value pairs to HSET (always includes updatedAt)
 *
 * Returns:
 *   1  = success
 *   0  = CAS mismatch (expectedStatus didn't match current)
 *  -1  = illegal state transition
 *  -2  = record not found
 *  -3  = (threadId, userId) drift — KEYS[2] is stale (e.g. reassignUserId race);
 *        caller must retry with fresh snapshot
 */
const ATOMIC_UPDATE_LUA = `
local current = redis.call('HGET', KEYS[1], 'status')
if not current then
  return -2
end

local expected = ARGV[1]
local newStatus = ARGV[2]

-- CAS check: if expectedStatus provided, current must match
if expected ~= '' and current ~= expected then
  return 0
end

-- F194 Phase B (cloud R13 P1 #2): KEYS[2] is derived from JS-side snapshot of
-- (threadId, userId). If reassignUserId() ran between snapshot and EVAL, the
-- snapshot is stale and SADD/SREM would target the wrong running set. Guard
-- by validating the hash's current (threadId, userId) match the snapshot.
local currentThreadId = redis.call('HGET', KEYS[1], 'threadId')
local currentUserId = redis.call('HGET', KEYS[1], 'userId')
if currentThreadId ~= ARGV[3] or currentUserId ~= ARGV[4] then
  return -3
end

-- State machine guard: validate transition when newStatus is provided.
-- Self-transitions (newStatus == current) are rejected for terminal states
-- because succeeded/canceled have empty allow-sets, matching isValidTransition().
if newStatus ~= '' then
  local transitions = {
    queued   = {running=1, failed=1, canceled=1},
    running  = {succeeded=1, failed=1, canceled=1},
    failed   = {running=1, canceled=1},
    succeeded = {},
    canceled  = {}
  }
  local allowed = transitions[current]
  if not allowed or not allowed[newStatus] then
    return -1
  end
end

-- Apply field/value pairs
local fields = {}
for i = 5, #ARGV, 2 do
  fields[#fields + 1] = ARGV[i]
  fields[#fields + 1] = ARGV[i + 1]
end
if #fields > 0 then
  redis.call('HSET', KEYS[1], unpack(fields))
end

-- F194 Phase B: maintain running index inside the same atomic op
if newStatus ~= '' and newStatus ~= current then
  local invocId = redis.call('HGET', KEYS[1], 'id')
  if newStatus == 'running' then
    redis.call('SADD', KEYS[2], invocId)
  elseif current == 'running' then
    redis.call('SREM', KEYS[2], invocId)
  end
end

return 1
`;

/**
 * F194 Phase B (cloud R14 P1): atomic running-set migration during ownership reassignment.
 *
 * Folds HSET userId + SREM oldSet + SADD newSet into a single Lua eval. Status is read
 * AFTER the HSET so concurrent terminal transitions are observed correctly — terminal
 * records skip Set migration (they belong in no running set).
 *
 * KEYS[1] = invocation record hash key
 * KEYS[2] = old running set key (running:{threadId}:{oldUserId})
 * KEYS[3] = new running set key (running:{threadId}:{nextUserId})
 * ARGV[1] = nextUserId
 * ARGV[2] = nowMs (string)
 * ARGV[3] = invocationId
 *
 * Returns:
 *   1  = success (migration applied or skipped per current status)
 *  -1  = record not found
 */
const REASSIGN_USERID_LUA = `
local exists = redis.call('EXISTS', KEYS[1])
if exists == 0 then
  return -1
end

redis.call('HSET', KEYS[1], 'userId', ARGV[1], 'updatedAt', ARGV[2])

local status = redis.call('HGET', KEYS[1], 'status')
if status == 'running' then
  redis.call('SREM', KEYS[2], ARGV[3])
  redis.call('SADD', KEYS[3], ARGV[3])
end

return 1
`;

export class RedisInvocationRecordStore implements IInvocationRecordStore {
  private readonly redis: RedisClient;
  // F194 Phase B (cloud R13 P1): per-process lazy backfill flag for the running index Set.
  // Records that existed in `running` BEFORE this build deployed (or written via paths that
  // bypass update()'s ATOMIC_UPDATE_LUA) won't be in `invoc:running:{tid}:{uid}`. On first
  // listRunningByThread call, scan all invoc:* hashes once, populate the Set, then flip the
  // flag. SADDs are idempotent so multi-process startup races at worst do duplicate work.
  private runningIndexBackfilled = false;
  private runningIndexBackfillPromise: Promise<void> | null = null;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  /** Resolve ioredis keyPrefix (SCAN doesn't auto-apply it) */
  private get keyPrefix(): string {
    return (this.redis.options as { keyPrefix?: string }).keyPrefix ?? '';
  }

  /** Strip keyPrefix from a raw SCAN key for use with normal commands (which auto-prefix) */
  private stripPrefix(rawKey: string): string {
    const p = this.keyPrefix;
    return p && rawKey.startsWith(p) ? rawKey.slice(p.length) : rawKey;
  }

  async create(input: CreateInvocationInput): Promise<CreateResult> {
    const { randomUUID } = await import('node:crypto');
    const id = randomUUID();
    const now = String(Date.now());

    // Bare keys — ioredis keyPrefix auto-applies to eval() KEYS[] too
    const idempKey = InvocationKeys.idempotency(input.threadId, input.userId, input.idempotencyKey);
    const recordKey = InvocationKeys.detail(id);

    const result = (await this.redis.eval(
      CREATE_ATOMIC_LUA,
      2,
      idempKey,
      recordKey,
      id,
      input.threadId,
      input.userId,
      JSON.stringify(input.targetCats),
      input.intent,
      input.idempotencyKey,
      now,
    )) as [string, string];

    return {
      outcome: result[0] as 'created' | 'duplicate',
      invocationId: result[1],
    };
  }

  async get(id: string): Promise<InvocationRecord | null> {
    const key = InvocationKeys.detail(id);
    const data = await this.redis.hgetall(key);
    if (!data || !data.id) return null;
    return this.hydrateRecord(data);
  }

  async update(id: string, input: UpdateInvocationInput): Promise<InvocationRecord | null> {
    const key = InvocationKeys.detail(id);

    // F194 Phase B (cloud R13 P1 #2): retry on (threadId, userId) drift caused by
    // concurrent reassignUserId(). The Lua's KEYS[2] (running set key) is derived
    // from a JS-side snapshot of the record's threadId/userId; if reassignUserId
    // migrates the record between snapshot and EVAL, KEYS[2] points at the wrong
    // set. The Lua guards via ARGV[3]/ARGV[4] and returns -3 on drift; we re-read
    // and retry. Loop bounded to prevent persistent reassignment from looping.
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const before = await this.get(id);
      if (!before) return null;
      const setKey = InvocationKeys.runningByThread(before.threadId, before.userId);

      const pairs = await this.buildUpdatePairs(key, input);

      const result = (await this.redis.eval(
        ATOMIC_UPDATE_LUA,
        2,
        key,
        setKey,
        input.expectedStatus ?? '',
        input.status ?? '',
        before.threadId,
        before.userId,
        ...pairs,
      )) as number;

      if (result === -3) continue; // drift: re-snapshot + retry
      // -2 = not found, 0 = CAS mismatch, -1 = illegal transition, 1 = success
      if (result !== 1) return null;
      return this.get(id);
    }
    return null; // exhausted retries — caller treats as transient failure
  }

  private async buildUpdatePairs(key: string, input: UpdateInvocationInput): Promise<string[]> {
    const pairs: string[] = [];
    pairs.push('updatedAt', String(Date.now()));
    if (input.status !== undefined) pairs.push('status', input.status);
    if (input.userMessageId !== undefined) pairs.push('userMessageId', input.userMessageId ?? '');
    if (input.error !== undefined) pairs.push('error', input.error);
    if (input.usageByCat !== undefined) {
      pairs.push('usageByCat', JSON.stringify(input.usageByCat));
      // F128: stamp usageRecordedAt on first usageByCat write (HSETNX semantics)
      const existing = await this.redis.hget(key, 'usageRecordedAt');
      if (!existing) pairs.push('usageRecordedAt', String(Date.now()));
    }
    return pairs;
  }

  async getByIdempotencyKey(threadId: string, userId: string, key: string): Promise<InvocationRecord | null> {
    const idempKey = InvocationKeys.idempotency(threadId, userId, key);
    const invocationId = await this.redis.get(idempKey);
    if (!invocationId) return null;
    return this.get(invocationId);
  }

  /**
   * F048: Scan all invocation records matching a given status.
   * Uses Redis SCAN (non-blocking cursor) + pipeline HGET for efficiency.
   *
   * IMPORTANT: ioredis SCAN does NOT auto-apply keyPrefix.
   * We must manually prepend the prefix for matching, then strip it from results.
   */
  async scanByStatus(status: InvocationStatus): Promise<string[]> {
    const matchPattern = `${this.keyPrefix}${InvocationKeys.detail('*')}`;
    const ids: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', matchPattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        const pipeline = this.redis.pipeline();
        for (const key of keys) {
          pipeline.hget(this.stripPrefix(key), 'status');
        }
        const results = await pipeline.exec();
        for (let i = 0; i < keys.length; i++) {
          const [err, val] = results?.[i]!;
          if (!err && val === status) {
            ids.push(this.stripPrefix(keys[i]!).replace(/^invoc:/, ''));
          }
        }
      }
    } while (cursor !== '0');
    return ids;
  }

  /**
   * F194 Phase B (cloud R5 P1 fix): Enumerate running InvocationRecords scoped to (threadId, userId).
   *
   * Index-backed (砚砚 R6 P1 push back): reads `invoc:running:{threadId}:{userId}` Set instead of
   * SCAN-ing all `invoc:*` hashes (hot read path; InvocationRecord is persistent so cardinality
   * is unbounded over time). The Set is maintained by `update`/`reassignUserId` at status
   * transitions; defensive HGETALL filter masks race-window stale members and best-effort SREM
   * cleans them up in-line.
   */
  async listRunningByThread(threadId: string, userId: string): Promise<InvocationRecord[]> {
    await this.ensureRunningIndexBackfilled();
    const setKey = InvocationKeys.runningByThread(threadId, userId);
    const ids = await this.redis.smembers(setKey);
    if (ids.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.hgetall(InvocationKeys.detail(id));
    const results = await pipeline.exec();

    const out: InvocationRecord[] = [];
    const staleIds: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const [err, data] = results?.[i] ?? [null, null];
      if (err || !data || typeof data !== 'object') continue;
      const d = data as Record<string, string>;
      if (!d.id || d.status !== 'running' || d.threadId !== threadId || d.userId !== userId) {
        staleIds.push(ids[i]!);
        continue;
      }
      out.push(this.hydrateRecord(d));
    }
    if (staleIds.length > 0) {
      this.redis.srem(setKey, ...staleIds).catch(() => {}); // fire-and-forget cleanup
    }
    return out;
  }

  /**
   * F194 Phase B (cloud R13 P1): one-time per-process backfill of the running index.
   *
   * `update()` maintains `invoc:running:{tid}:{uid}` Sets atomically inside ATOMIC_UPDATE_LUA,
   * but records that existed in `running` BEFORE this build deployed are absent from those Sets.
   * Without backfill, listRunningByThread (now SMEMBERS-only) returns [] for orphaned records,
   * which makes /messages drop live drafts and /queue show no active slot.
   *
   * This method scans all invoc:* hashes once per process, SADDs each `running` record into
   * its (threadId, userId) Set, then flips a flag so subsequent reads are pure SMEMBERS.
   * SADDs are idempotent — concurrent multi-process startup at worst does duplicate work.
   *
   * On scan error: clears the in-flight promise so the next call retries; the original error
   * propagates so the caller can decide whether to fail-open. Read-path correctness depends
   * on backfill completing at least once per process.
   */
  private async ensureRunningIndexBackfilled(): Promise<void> {
    if (this.runningIndexBackfilled) return;
    if (!this.runningIndexBackfillPromise) {
      this.runningIndexBackfillPromise = this.scanAndPopulateRunningIndex();
    }
    try {
      await this.runningIndexBackfillPromise;
      this.runningIndexBackfilled = true;
    } finally {
      this.runningIndexBackfillPromise = null;
    }
  }

  private async scanAndPopulateRunningIndex(): Promise<void> {
    // Cloud R16 P2: `invoc:running:{tid}:{uid}` set keys share the `invoc:*` prefix used
    // by record hashes. SCAN MATCH returns BOTH; HGETALL on a set returns WRONGTYPE
    // (caught by our defensive filter), but the round-trips still cost. Pre-filter the
    // scan results to exclude running-set keys before pipelining HGETALL.
    const matchPattern = `${this.keyPrefix}${InvocationKeys.detail('*')}`;
    const runningSetPrefix = 'invoc:running:';
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', matchPattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length === 0) continue;

      // Filter out running-index set keys (invoc:running:{tid}:{uid}) — they match the
      // SCAN pattern but are sets, not record hashes. HGETALL on a set wastes a round-trip
      // and returns WRONGTYPE.
      const recordKeys = keys.filter((key) => !this.stripPrefix(key).startsWith(runningSetPrefix));
      if (recordKeys.length === 0) continue;

      const hgetalls = this.redis.pipeline();
      for (const key of recordKeys) hgetalls.hgetall(this.stripPrefix(key));
      const results = await hgetalls.exec();

      const sadds = this.redis.pipeline();
      let count = 0;
      for (const entry of results ?? []) {
        const [err, data] = entry ?? [null, null];
        if (err || !data || typeof data !== 'object') continue;
        const d = data as Record<string, string>;
        if (d.id && d.status === 'running' && d.threadId && d.userId) {
          sadds.sadd(InvocationKeys.runningByThread(d.threadId, d.userId), d.id);
          count++;
        }
      }
      if (count > 0) await sadds.exec();
    } while (cursor !== '0');
  }

  /**
   * F128: Scan ALL invocation records.
   * Uses Redis SCAN (non-blocking cursor) + pipeline HGETALL for full hydration.
   */
  async scanAll(): Promise<InvocationRecord[]> {
    const matchPattern = `${this.keyPrefix}${InvocationKeys.detail('*')}`;
    const records: InvocationRecord[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', matchPattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        const pipeline = this.redis.pipeline();
        for (const key of keys) {
          pipeline.hgetall(this.stripPrefix(key));
        }
        const results = await pipeline.exec();
        for (const entry of results ?? []) {
          const [err, data] = entry!;
          if (!err && data && typeof data === 'object' && (data as Record<string, string>).id) {
            records.push(this.hydrateRecord(data as Record<string, string>));
          }
        }
      }
    } while (cursor !== '0');
    return records;
  }

  /** Reassign invocation ownership to a different userId (repair helper for scheduler backfill). */
  async reassignUserId(id: string, nextUserId: string): Promise<InvocationRecord | null> {
    const record = await this.get(id);
    if (!record) return null;
    if (record.userId === nextUserId) return record;

    // F194 Phase B (cloud R14 P1): atomically migrate ownership.
    // Old code did HSET userId → SREM oldSet → SADD newSet as 3 separate awaits;
    // a crash between SREM and SADD could leave a running record in NEITHER set,
    // invisible to listRunningByThread for either old or new owner.
    // Fix: fold HSET + SREM + SADD into one Lua eval. Status is read INSIDE Lua
    // (post-HSET) — if a concurrent update() drove status to terminal, the Lua
    // skips Set migration (terminal records belong in no running set).
    const recordKey = InvocationKeys.detail(id);
    const oldSetKey = InvocationKeys.runningByThread(record.threadId, record.userId);
    const newSetKey = InvocationKeys.runningByThread(record.threadId, nextUserId);
    await this.redis.eval(REASSIGN_USERID_LUA, 3, recordKey, oldSetKey, newSetKey, nextUserId, String(Date.now()), id);

    // Idempotency key migration: separate from Set migration (not on liveness hot path)
    const oldIdempKey = InvocationKeys.idempotency(record.threadId, record.userId, record.idempotencyKey);
    const newIdempKey = InvocationKeys.idempotency(record.threadId, nextUserId, record.idempotencyKey);
    const claimedId = await this.redis.get(oldIdempKey);
    if (claimedId === id) {
      const ttl = await this.redis.ttl(oldIdempKey);
      const pipeline = this.redis.multi();
      pipeline.del(oldIdempKey);
      if (ttl > 0) {
        pipeline.set(newIdempKey, id, 'EX', ttl);
      } else {
        pipeline.set(newIdempKey, id);
      }
      await pipeline.exec();
    }

    return this.get(id);
  }

  private hydrateRecord(data: Record<string, string>): InvocationRecord {
    const errorValue = data.error;
    const hasError = errorValue !== undefined && errorValue !== '';
    const usageByCat = safeParseObject(data.usageByCat);
    return {
      id: data.id!,
      threadId: data.threadId!,
      userId: data.userId!,
      userMessageId: data.userMessageId === '' ? null : data.userMessageId!,
      targetCats: safeParseArray(data.targetCats) as CatId[],
      intent: (data.intent as 'execute' | 'ideate') ?? 'execute',
      status: (data.status as InvocationStatus) ?? 'queued',
      idempotencyKey: data.idempotencyKey!,
      ...(hasError ? { error: errorValue } : {}),
      ...(usageByCat ? { usageByCat } : {}),
      ...(data.usageRecordedAt ? { usageRecordedAt: parseInt(data.usageRecordedAt, 10) } : {}),
      createdAt: parseInt(data.createdAt!, 10),
      updatedAt: parseInt(data.updatedAt!, 10),
    };
  }
}

function safeParseArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeParseObject(value: string | undefined): Record<string, TokenUsage> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, TokenUsage>)
      : null;
  } catch {
    return null;
  }
}
