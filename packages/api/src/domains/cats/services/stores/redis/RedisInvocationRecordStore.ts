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
import {
  type CreateInvocationInput,
  type CreateResult,
  type IInvocationRecordStore,
  type InvocationActionLeaseRef,
  type InvocationRecord,
  type InvocationStatus,
  normalizeSuccessfulCatIds,
  requireInvocationActionLeaseCarrier,
  requireInvocationWaitContinuationCarrier,
  type UpdateInvocationInput,
} from '../ports/InvocationRecordStore.js';
import { InvocationKeys } from '../redis-keys/invocation-keys.js';
import { decodeInvocationHash } from './invocation-record-redis-codec.js';

/**
 * SCAN MATCH `invoc:*` 命中记录 hash 之外，还命中两类 running 索引 SET——对它们发 HGETALL
 * 会 WRONGTYPE。backfill 与 scanAll 共用同一份排除清单：判据只写一遍（第一份漏掉
 * `running-threads` 的教训被静默吞错掩盖了三轮 review 才暴露）。
 */
const RUNNING_SET_PREFIXES = ['invoc:running:', 'invoc:running-threads:'] as const;
const DETAIL_KEY_PREFIX = InvocationKeys.detail('');

const DEFAULT_TTL_SECONDS = 0; // persistent — set >0 via env to enable expiry
const IDEMPOTENCY_TTL_SECONDS = 300; // 5 minutes

/**
 * Lua script for atomic idempotency check + record creation.
 * KEYS[1] = idempotency key (ioredis auto-prefixes)
 * KEYS[2] = invocation record key (ioredis auto-prefixes)
 * ARGV[1..9] = id, threadId, userId, targetCats(JSON), intent, idempotencyKey, now,
 *              actionLeaseCarrier(JSON), waitContinuationCarrier(JSON or empty)
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
  'actionLeaseCarrier', ARGV[8],
  'createdAt', ARGV[7], 'updatedAt', ARGV[7])
if ARGV[9] ~= '' then
  redis.call('HSET', KEYS[2], 'waitContinuationCarrier', ARGV[9])
end
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
 * KEYS[3] = per-user running-thread candidate index
 * KEYS[4] = latest terminal InvocationRecord pointer for (threadId, userId)
 * ARGV[1] = expectedStatus ("" if non-CAS)
 * ARGV[2] = newStatus ("" if no status change)
 * ARGV[3] = expectedThreadId (matches snapshot used to derive KEYS[2])
 * ARGV[4] = expectedUserId (matches snapshot used to derive KEYS[2])
 * ARGV[5] = expectedUsageByCatAbsent ("1" if usageByCat must be missing/empty)
 * ARGV[6..N] = field/value pairs to HSET (always includes updatedAt)
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

local expectedUsageByCatAbsent = ARGV[5]
if expectedUsageByCatAbsent == '1' then
  local currentUsageByCat = redis.call('HGET', KEYS[1], 'usageByCat')
  if currentUsageByCat and currentUsageByCat ~= '' and currentUsageByCat ~= '{}' then
    return 0
  end
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
for i = 6, #ARGV, 2 do
  fields[#fields + 1] = ARGV[i]
  fields[#fields + 1] = ARGV[i + 1]
end
if #fields > 0 then
  redis.call('HSET', KEYS[1], unpack(fields))
end

-- executionStartedAt is an attempt-scoped receipt, not an invocation-lifetime
-- fact. Any accepted transition into running begins a new attempt, so clear a
-- previous attempt's receipt in the same atomic claim operation.
if newStatus == 'running' and current ~= 'running' then
  redis.call('HDEL', KEYS[1], 'executionStartedAt')
end

-- F194 Phase B: maintain running index inside the same atomic op.
-- F297 (cloud R7 P2): KEYS[3] is the per-user running-thread index. It MUST be written in
-- the same atomic op as KEYS[2] — a fire-and-forget write could drop a thread and produce a
-- false terminal (a running row rendered as done/error), which F297 forbids outright.
if newStatus ~= '' and newStatus ~= current then
  local invocId = redis.call('HGET', KEYS[1], 'id')
  if newStatus == 'running' then
    redis.call('SADD', KEYS[2], invocId)
    redis.call('SADD', KEYS[3], currentThreadId)
  elseif current == 'running' then
    redis.call('SREM', KEYS[2], invocId)
    -- 只有该 thread 再无 running invocation 时才退出候选索引
    if redis.call('SCARD', KEYS[2]) == 0 then
      redis.call('SREM', KEYS[3], currentThreadId)
    end
  end

  -- F297: terminal presentation requires a lifecycle witness.  Maintain the newest
  -- terminal transition in the same atomic operation as the record status.  Retrying a
  -- failed invocation clears its own pointer so a stale failure cannot survive re-entry.
  if newStatus == 'succeeded' or newStatus == 'failed' or newStatus == 'canceled' then
    redis.call('SET', KEYS[4], invocId)
  elseif newStatus == 'running' and redis.call('GET', KEYS[4]) == invocId then
    redis.call('DEL', KEYS[4])
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
 * F297 (cloud R7 P2): the per-user candidate index migrates with ownership too, in the
 * same atomic op — otherwise the new owner's sidebar would miss a running thread (漏报).
 *
 * KEYS[1] = invocation record hash key
 * KEYS[2] = old running set key (running:{threadId}:{oldUserId})
 * KEYS[3] = new running set key (running:{threadId}:{nextUserId})
 * KEYS[4] = old owner candidate index (invoc:running-threads:{oldUserId})
 * KEYS[5] = new owner candidate index (invoc:running-threads:{nextUserId})
 * KEYS[6] = old owner's latest terminal pointer for this thread
 * ARGV[1] = nextUserId
 * ARGV[2] = nowMs (string)
 * ARGV[3] = invocationId
 * ARGV[4] = threadId
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
  -- F297 (cloud R7 P2): per-user running-thread index follows ownership.
  -- KEYS[4]=old owner index, KEYS[5]=new owner index, ARGV[4]=threadId
  redis.call('SADD', KEYS[5], ARGV[4])
  if redis.call('SCARD', KEYS[2]) == 0 then
    redis.call('SREM', KEYS[4], ARGV[4])
  end
end


-- Scheduler ownership repair must not leave a terminal pointer visible to the old owner.
-- We deliberately do not invent history for the new owner; a future terminal transition
-- will create its pointer under the repaired ownership.
if redis.call('GET', KEYS[6]) == ARGV[3] then
  redis.call('DEL', KEYS[6])
end

return 1
`;

export class RedisInvocationRecordStore implements IInvocationRecordStore {
  private readonly redis: RedisClient;
  // F194 Phase B (cloud R13 P1): per-process lazy backfill flag for the running index Set.
  // Records that existed in `running` BEFORE this build deployed (or written via paths that
  // bypass update()'s ATOMIC_UPDATE_LUA) won't be in `invoc:running:{tid}:{uid}`. On first
  // first call of EITHER read API (listRunningByThread / listRunningThreadIds), scan all
  // invoc:* hashes once, populate both the per-thread Set and the per-user candidate index
  // (F297 cloud R7 P2), then flip the flag. SADDs are idempotent so multi-process startup
  // races at worst do duplicate work.
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
    const waitContinuationCarrier = requireInvocationWaitContinuationCarrier(input.waitContinuationCarrier);

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
      JSON.stringify(requireInvocationActionLeaseCarrier(input.actionLeaseCarrier)),
      waitContinuationCarrier ? JSON.stringify(waitContinuationCarrier) : '',
    )) as [string, string];

    return {
      outcome: result[0] as 'created' | 'duplicate',
      invocationId: result[1],
    };
  }

  async get(id: string): Promise<InvocationRecord | null> {
    const key = InvocationKeys.detail(id);
    const data = await this.redis.hgetall(key);
    // R12 P1：单条读同样走 domain codec。损坏 hash 以前被 `!data.id` 降级成 null（false
    // absent = false terminal 方向），现在是未知 ⇒ 抛出。
    const decoded = decodeInvocationHash([null, data], id, `invocation record ${id}`);
    return decoded.kind === 'absent' ? null : decoded.record;
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
      const userThreadsKey = InvocationKeys.runningThreadsByUser(before.userId);
      const latestTerminalKey = InvocationKeys.latestTerminalByThread(before.threadId, before.userId);
      const successfulCatIds = normalizeSuccessfulCatIds(before.targetCats, input);

      const pairs = await this.buildUpdatePairs(key, input, successfulCatIds);

      const result = (await this.redis.eval(
        ATOMIC_UPDATE_LUA,
        4,
        key,
        setKey,
        userThreadsKey,
        latestTerminalKey,
        input.expectedStatus ?? '',
        input.status ?? '',
        before.threadId,
        before.userId,
        input.expectedUsageByCatAbsent === true ? '1' : '',
        ...pairs,
      )) as number;

      if (result === -3) continue; // drift: re-snapshot + retry
      // -2 = not found, 0 = CAS mismatch, -1 = illegal transition, 1 = success
      if (result !== 1) return null;
      return this.get(id);
    }
    return null; // exhausted retries — caller treats as transient failure
  }

  private async buildUpdatePairs(
    key: string,
    input: UpdateInvocationInput,
    successfulCatIds: CatId[] | undefined,
  ): Promise<string[]> {
    const pairs: string[] = [];
    pairs.push('updatedAt', String(Date.now()));
    if (input.status !== undefined) pairs.push('status', input.status);
    if (successfulCatIds !== undefined) pairs.push('successfulCatIds', JSON.stringify(successfulCatIds));
    if (input.userMessageId !== undefined) pairs.push('userMessageId', input.userMessageId ?? '');
    if (input.error !== undefined) pairs.push('error', input.error);
    if (input.executionStartedAt !== undefined) pairs.push('executionStartedAt', String(input.executionStartedAt));
    if (input.freshnessClosureId !== undefined) pairs.push('freshnessClosureId', input.freshnessClosureId);
    if (input.freshnessInputFrontierMessageId !== undefined) {
      pairs.push('freshnessInputFrontierMessageId', input.freshnessInputFrontierMessageId);
    }
    if (input.freshnessClosureStatus !== undefined) {
      pairs.push('freshnessClosureStatus', input.freshnessClosureStatus);
    }
    if (input.usageByCat !== undefined) {
      pairs.push('usageByCat', JSON.stringify(input.usageByCat));
      // F128: stamp usageRecordedAt on first usageByCat write (HSETNX semantics).
      // Issue #845 backfill: explicit input.usageRecordedAt overrides — anchored to the
      // stable historical completion signal chosen by the planner.
      if (input.usageRecordedAt != null) {
        pairs.push('usageRecordedAt', String(input.usageRecordedAt));
      } else {
        const existing = await this.redis.hget(key, 'usageRecordedAt');
        if (!existing) pairs.push('usageRecordedAt', String(Date.now()));
      }
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
  /**
   * F297 OQ-1: user-scoped sparse candidate index。
   *
   * 由 per-user 候选索引 `invoc:running-threads:{userId}` 直接寻址（cloud R7 P2）。
   * R2 原本刻意不建这份索引、改用 `SCAN MATCH invoc:running:*:{userId}`，理由是避免
   * 回填/对账；但 Redis 的 SCAN **仍遍历整个 keyspace**（MATCH 只过滤返回值），实测
   * dbsize 200k 时 201ms，而 sidebar 每次挂载/重连都会走这里，也违反 F297 spec 的
   * 「常数 pipeline stage」。有了成本数据后该取舍被推翻，回填复用既有
   * `ensureRunningIndexBackfilled` 一趟完成。
   *
   * **漂移方向刻意落在安全侧**：索引 SADD 与 per-thread running set 在同一原子 Lua 内写入，
   * 所以不会漏报；写侧终态 SREM + 读侧 SCARD 校验消除多报。允许短暂多报（candidate 只是
   * "要问 classifier 的对象"），但绝不能漏报——漏报会让真实 working 的 thread 被终态回落
   * 误显示成 done/error（PR #3748 R2 P1-1）。
   *
   * 同理，SCARD 读故障**不算**空集合：未知不得当成"没在跑"（local R8 P1）。
   */
  async listRunningThreadIds(userId: string): Promise<string[]> {
    await this.ensureRunningIndexBackfilled();
    // F297 (cloud R7 P2): 直接寻址，1 次 SMEMBERS + 1 次 pipeline —— 成本随「在跑的 thread 数」
    // 增长，而不是随整个 keyspace。旧实现用 SCAN MATCH，而 Redis 的 SCAN 仍会遍历整个
    // keyspace（MATCH 只过滤返回值），把 sidebar 挂载/重连变成 O(所有持久化键)。
    const indexKey = InvocationKeys.runningThreadsByUser(userId);
    const candidates = await this.redis.smembers(indexKey);
    if (candidates.length === 0) return [];

    // 索引是候选加速器，真相仍是 per-thread running set：SCARD 校验消除多报。
    // 方向性：SADD 与 running set 同原子写 ⇒ 不会漏报；残留只会多报，而多报由此处过滤。
    const pipeline = this.redis.pipeline();
    for (const threadId of candidates) pipeline.scard(InvocationKeys.runningByThread(threadId, userId));
    const results = (await pipeline.exec()) ?? [];

    const live: string[] = [];
    const stale: string[] = [];
    for (const [index, threadId] of candidates.entries()) {
      const entry = results[index];
      // **只有权威的空集合才算 stale**（error == null && size === 0）。
      //
      // 读故障绝不能被当成"没在跑"：那会让真实候选当次消失，方法却仍正常 resolve，
      // 于是调用方把这一源记成成功、discovery 标 complete、Sidebar 直接走终态回落
      // = false terminal；紧接着的 SREM 还会把一次瞬时读故障**固化成持久漏报**
      // （本进程 backfill flag 已置位，不会自行修复）。
      // 抛出去，让 `resolveWorkingPresence` / `buildSnapshot` 的 completeness 记账封成 idle。
      if (!entry) throw new Error(`SCARD reply missing for running-thread candidate ${threadId}`);
      const [error, size] = entry;
      if (error) throw error;
      if (typeof size !== 'number') {
        throw new Error(`SCARD returned a non-numeric reply for running-thread candidate ${threadId}`);
      }
      if (size > 0) live.push(threadId);
      else stale.push(threadId);
    }
    // 与既有 listRunningByThread 的 stale 清理同模式：观测路径不阻塞，清理 fire-and-forget。
    if (stale.length > 0) this.redis.srem(indexKey, ...stale).catch(() => {});
    return live;
  }

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
      // audit（cloud R9 P1 同类）：本方法喂给 `resolveActiveInvocationsStrict`。若在 store 层
      // 静默吞掉读错误，strict 路径永远拿不到异常，整条 fail-closed 链就是假的 ——
      // 少报 running record 会让 live 面报空却仍标 complete，进而 false terminal。
      const id = ids[i]!;
      // R12 P1：判据整体收口到 domain codec —— transport validity ≠ record validity。
      // envelope 未知与 record 未知（缺 owner 字段 / 非法 status / 坏 targetCats / NaN 时间戳）
      // 一律抛出，禁止降成 stale（stale 会连带 SREM，把一次异常固化成持久漏报）。
      const decoded = decodeInvocationHash(results?.[i], id, `invocation record ${id}`);
      // 权威空：记录已删 ⇒ 索引里的 stale 成员。
      if (decoded.kind === 'absent') {
        staleIds.push(id);
        continue;
      }
      // 完整合法记录才有资格被判定：权威非 running / scope 不符 = 可证明非 live ⇒ stale。
      const record = decoded.record;
      if (decoded.kind === 'not_running' || record.threadId !== threadId || record.userId !== userId) {
        staleIds.push(id);
        continue;
      }
      out.push(record);
    }
    if (staleIds.length > 0) {
      this.redis.srem(setKey, ...staleIds).catch(() => {}); // fire-and-forget cleanup
    }
    return out;
  }

  async listLatestTerminalByThreadIds(
    threadIds: readonly string[],
    userId: string,
  ): Promise<Map<string, InvocationRecord>> {
    const out = new Map<string, InvocationRecord>();
    if (threadIds.length === 0) return out;

    const ids = await this.redis.mget(
      ...threadIds.map((threadId) => InvocationKeys.latestTerminalByThread(threadId, userId)),
    );
    const reads = this.redis.pipeline();
    const requested: Array<{ threadId: string; invocationId: string }> = [];
    for (const [index, invocationId] of ids.entries()) {
      if (!invocationId) continue;
      const threadId = threadIds[index]!;
      requested.push({ threadId, invocationId });
      reads.hgetall(InvocationKeys.detail(invocationId));
    }
    if (requested.length === 0) return out;

    const results = await reads.exec();
    for (const [index, request] of requested.entries()) {
      const decoded = decodeInvocationHash(
        results?.[index],
        request.invocationId,
        `latest terminal invocation ${request.invocationId}`,
      );
      if (decoded.kind === 'absent') continue;
      const record = decoded.record;
      if (record.threadId !== request.threadId || record.userId !== userId) continue;
      if (record.status !== 'succeeded' && record.status !== 'failed' && record.status !== 'canceled') continue;
      out.set(request.threadId, record);
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
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', matchPattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length === 0) continue;

      // Filter out running-index set keys (invoc:running:{tid}:{uid}) — they match the
      // SCAN pattern but are sets, not record hashes. HGETALL on a set wastes a round-trip
      // and returns WRONGTYPE.
      const recordKeys = keys.filter((key) => {
        const bare = this.stripPrefix(key);
        return !RUNNING_SET_PREFIXES.some((prefix) => bare.startsWith(prefix));
      });
      if (recordKeys.length === 0) continue;

      const hgetalls = this.redis.pipeline();
      for (const key of recordKeys) hgetalls.hgetall(this.stripPrefix(key));
      const results = await hgetalls.exec();

      const sadds = this.redis.pipeline();
      let count = 0;
      for (let index = 0; index < recordKeys.length; index += 1) {
        // cloud R12 P1 + local R12 P1：backfill 以前手写 `if (err || !data ...) continue`，
        // 后来又手写 `if (d.id && d.status === 'running' && ...)` —— record-invalid 的 hash
        // （status=banana / 缺 owner 字段）被静默 skip 后 flag 仍置位，pre-deploy running
        // thread 被**永久**漏报。收口到 domain codec：未知抛出 → abort 本轮 → flag 不置位
        // → 下次读 API 自动重试；只有权威 running 才 seed 索引。
        const bareKey = this.stripPrefix(recordKeys[index]!);
        const expectedId = bareKey.slice(DETAIL_KEY_PREFIX.length);
        const decoded = decodeInvocationHash(results?.[index], expectedId, `running index backfill ${bareKey}`);
        if (decoded.kind !== 'running') continue; // absent（已删）/ 权威非 running：不 seed
        const record = decoded.record;
        sadds.sadd(InvocationKeys.runningByThread(record.threadId, record.userId), record.id);
        // F297 (cloud R7 P2): seed the per-user candidate index in the same backfill pass,
        // otherwise pre-deploy running records would be invisible to the sidebar (漏报).
        sadds.sadd(InvocationKeys.runningThreadsByUser(record.userId), record.threadId);
        count++;
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
      // R12 P1（同类审视）：scanAll 以前手写 `if (!err && data.id)` —— 静默吞掉 WRONGTYPE
      // （SCAN 命中 running 索引 SET）**和**损坏记录。它喂 zombie recovery 与 duty briefing
      // 的 liveness 判断，静默 omit = zombie 永不恢复。收口到同一 codec + 同一 SET 排除清单；
      // 上层（Reaper 周期重试 / briefing safeCollect 降级）已能承接抛出。
      const recordKeys = keys.filter((key) => {
        const bare = this.stripPrefix(key);
        return !RUNNING_SET_PREFIXES.some((prefix) => bare.startsWith(prefix));
      });
      if (recordKeys.length > 0) {
        const pipeline = this.redis.pipeline();
        for (const key of recordKeys) {
          pipeline.hgetall(this.stripPrefix(key));
        }
        const results = await pipeline.exec();
        for (let index = 0; index < recordKeys.length; index += 1) {
          const bareKey = this.stripPrefix(recordKeys[index]!);
          const expectedId = bareKey.slice(DETAIL_KEY_PREFIX.length);
          const decoded = decodeInvocationHash(results?.[index], expectedId, `invocation scan ${bareKey}`);
          if (decoded.kind === 'absent') continue; // scan 与删除并发：key 已消失
          records.push(decoded.record);
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
    const oldUserThreadsKey = InvocationKeys.runningThreadsByUser(record.userId);
    const newUserThreadsKey = InvocationKeys.runningThreadsByUser(nextUserId);
    const oldLatestTerminalKey = InvocationKeys.latestTerminalByThread(record.threadId, record.userId);
    await this.redis.eval(
      REASSIGN_USERID_LUA,
      6,
      recordKey,
      oldSetKey,
      newSetKey,
      oldUserThreadsKey,
      newUserThreadsKey,
      oldLatestTerminalKey,
      nextUserId,
      String(Date.now()),
      id,
      record.threadId,
    );

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
}
