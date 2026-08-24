/**
 * Redis Session Chain Store
 * F24: Redis-backed session chain storage.
 *
 * Data model:
 * - Hash per session record (session:{id})
 * - Sorted Set per cat+thread chain (session-chain:{catId}:{threadId}, score=seq)
 * - Set per thread (session-chain-by-thread:{threadId} → cat+thread chain keys)
 * - String for legacy/global active index (session-active:{catId}:{threadId} → id)
 * - String for owner active index (session-active-owner:{userId}:{catId}:{threadId} → id)
 * - String for CLI index (session-cli:{cliSessionId} → id)
 *
 * IMPORTANT: ioredis keyPrefix auto-prefixes ALL commands including eval() KEYS[].
 * Pass bare keys only.
 */

import type {
  CatHandoffNote,
  CatId,
  ContextHealth,
  HybridProgress,
  SessionCapacityPin,
  SessionPolicySnapshot,
  SessionRecord,
  SessionStatus,
  SessionUsageSnapshot,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  CompressionEventResult,
  CreateSessionInput,
  ISessionChainStore,
  RestoreActiveSessionInput,
  RestoreActiveSessionResult,
  SessionRecordPatch,
} from '../ports/SessionChainStore.js';
import type { StoreReadOptions } from '../ports/StoreReadOptions.js';
import { awaitStoreRead, throwIfStoreReadAborted } from '../ports/StoreReadOptions.js';
import { SessionChainKeys } from '../redis-keys/session-chain-keys.js';

const DEFAULT_TTL_SECONDS = 0; // persistent — set >0 via env to enable expiry

/**
 * Lua: atomic create session record.
 * KEYS[1] = active key, KEYS[2] = chain key, KEYS[3] = detail key,
 * KEYS[4] = cli key, KEYS[5] = chainKey index key (F198; dummy when no chainKey),
 * KEYS[6] = thread chain-key index
 * ARGV[1] = id, ARGV[2] = cliSessionId, ARGV[3] = threadId, ARGV[4] = catId,
 * ARGV[5] = userId, ARGV[6] = now, ARGV[7] = reuseExistingCliSession flag,
 * ARGV[8] = chainKey value ('' = none, KEYS[5] left untouched)
 * ARGV[9] = workingDirectory ('' = none), ARGV[10] = workspaceFingerprint ('' = none)
 * ARGV[11] = bare cat+thread chain key (Lua KEYS are keyPrefix-expanded by ioredis)
 * ARGV[12] = reuse existing active flag, ARGV[13] = initial compression count ('' = unknown)
 * KEYS[7] = owner-scoped active pointer
 *
 * Returns: {'existing', existingId} when cliSessionId is already claimed,
 *          {'created', id, seq} when a new record is created.
 */
const CREATE_LUA = `
if ARGV[12] == '1' then
  local existingActive = redis.call('GET', KEYS[7])
  if existingActive then return {'existing_active', existingActive} end
end
if ARGV[7] == '1' and ARGV[2] ~= '' then
  local existingId = redis.call('GET', KEYS[4])
  if existingId then return {'existing', existingId} end
end
local seq = 0
local detailPrefix = string.sub(KEYS[3], 1, string.len(KEYS[3]) - string.len(ARGV[1]))
for _, chainId in ipairs(redis.call('ZRANGE', KEYS[2], 0, -1)) do
  if redis.call('HGET', detailPrefix .. chainId, 'userId') == ARGV[5] then seq = seq + 1 end
end
redis.call('HSET', KEYS[3],
  'id', ARGV[1], 'threadId', ARGV[3],
  'catId', ARGV[4], 'userId', ARGV[5], 'seq', tostring(seq),
  'status', 'active', 'messageCount', '0',
  'createdAt', ARGV[6], 'updatedAt', ARGV[6])
if ARGV[2] ~= '' then redis.call('HSET', KEYS[3], 'cliSessionId', ARGV[2]) end
if ARGV[13] ~= '' then redis.call('HSET', KEYS[3], 'compressionCount', ARGV[13]) end
if ARGV[8] ~= '' then
  redis.call('HSET', KEYS[3], 'chainKey', ARGV[8])
  ${DEFAULT_TTL_SECONDS > 0 ? `redis.call('SET', KEYS[5], ARGV[1], 'EX', ${DEFAULT_TTL_SECONDS})` : `redis.call('SET', KEYS[5], ARGV[1])`}
end
if ARGV[9] ~= '' then redis.call('HSET', KEYS[3], 'workingDirectory', ARGV[9]) end
if ARGV[10] ~= '' then redis.call('HSET', KEYS[3], 'workspaceFingerprint', ARGV[10]) end
${DEFAULT_TTL_SECONDS > 0 ? `redis.call('EXPIRE', KEYS[3], ${DEFAULT_TTL_SECONDS})` : '-- persistent mode: no EXPIRE'}
redis.call('ZADD', KEYS[2], seq, ARGV[1])
${DEFAULT_TTL_SECONDS > 0 ? `redis.call('EXPIRE', KEYS[2], ${DEFAULT_TTL_SECONDS})` : '-- persistent mode: no EXPIRE'}
redis.call('SADD', KEYS[6], ARGV[11])
${DEFAULT_TTL_SECONDS > 0 ? `redis.call('EXPIRE', KEYS[6], ${DEFAULT_TTL_SECONDS})` : '-- persistent mode: no EXPIRE'}
${DEFAULT_TTL_SECONDS > 0 ? `redis.call('SET', KEYS[1], ARGV[1], 'EX', ${DEFAULT_TTL_SECONDS})` : `redis.call('SET', KEYS[1], ARGV[1])`}
${DEFAULT_TTL_SECONDS > 0 ? `redis.call('SET', KEYS[7], ARGV[1], 'EX', ${DEFAULT_TTL_SECONDS})` : `redis.call('SET', KEYS[7], ARGV[1])`}
if ARGV[2] ~= '' then
  ${DEFAULT_TTL_SECONDS > 0 ? `redis.call('SET', KEYS[4], ARGV[1], 'EX', ${DEFAULT_TTL_SECONDS})` : `redis.call('SET', KEYS[4], ARGV[1])`}
end
return {'created', ARGV[1], tostring(seq)}
`;

const BIND_CLI_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end
if redis.call('HGET', KEYS[1], 'status') ~= 'active' then return {'inactive'} end
local claimedBy = redis.call('GET', KEYS[2])
if claimedBy and claimedBy ~= ARGV[1] then return {'conflict', claimedBy} end
local oldCli = redis.call('HGET', KEYS[1], 'cliSessionId') or ''
redis.call('HSET', KEYS[1], 'cliSessionId', ARGV[2], 'updatedAt', ARGV[3])
${DEFAULT_TTL_SECONDS > 0 ? `redis.call('SET', KEYS[2], ARGV[1], 'EX', ${DEFAULT_TTL_SECONDS})` : `redis.call('SET', KEYS[2], ARGV[1])`}
return {'bound', oldCli}
`;

const COMPARE_DELETE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

const TRANSITION_TO_SEALING_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if redis.call('HGET', KEYS[1], 'status') ~= 'active' then return -1 end
if ARGV[4] ~= '' and redis.call('HGET', KEYS[1], 'appliedPolicyRevision') ~= ARGV[4] then return -2 end
redis.call('HSET', KEYS[1],
  'status', 'sealing',
  'sealReason', ARGV[2],
  'updatedAt', ARGV[3])
if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
if redis.call('GET', KEYS[3]) == ARGV[1] then redis.call('DEL', KEYS[3]) end
return 1
`;

/**
 * Atomic manual session restore.
 * KEYS[1] target detail, KEYS[2] legacy active pointer,
 * KEYS[3] owner active pointer, KEYS[4] expected active detail (dummy when none).
 * ARGV[1] target id, ARGV[2] expected active id ('' when none),
 * ARGV[3] displaced seal reason, ARGV[4] now,
 * ARGV[5] user id, ARGV[6] cat id, ARGV[7] thread id.
 */
const RESTORE_ACTIVE_SESSION_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'target_missing'} end
if redis.call('HGET', KEYS[1], 'userId') ~= ARGV[5]
  or redis.call('HGET', KEYS[1], 'catId') ~= ARGV[6]
  or redis.call('HGET', KEYS[1], 'threadId') ~= ARGV[7] then
  return {'target_missing'}
end
local actualActive = redis.call('GET', KEYS[3]) or ''
local targetStatus = redis.call('HGET', KEYS[1], 'status') or ''
if targetStatus == 'active' and actualActive == ARGV[1] then
  return {'already_active'}
end
if targetStatus ~= 'sealed' then
  return {'target_not_restorable', targetStatus}
end
if actualActive ~= ARGV[2] then
  return {'active_changed', actualActive}
end
if actualActive ~= '' then
  if redis.call('EXISTS', KEYS[4]) == 0
    or redis.call('HGET', KEYS[4], 'status') ~= 'active'
    or redis.call('HGET', KEYS[4], 'userId') ~= ARGV[5]
    or redis.call('HGET', KEYS[4], 'catId') ~= ARGV[6]
    or redis.call('HGET', KEYS[4], 'threadId') ~= ARGV[7] then
    return {'active_changed', actualActive}
  end
  redis.call('HSET', KEYS[4],
    'status', 'sealing',
    'sealReason', ARGV[3],
    'updatedAt', ARGV[4])
end
redis.call('HSET', KEYS[1], 'status', 'active', 'updatedAt', ARGV[4])
redis.call('HDEL', KEYS[1], 'sealReason', 'sealedAt')
${DEFAULT_TTL_SECONDS > 0 ? `redis.call('SET', KEYS[2], ARGV[1], 'EX', ${DEFAULT_TTL_SECONDS})` : `redis.call('SET', KEYS[2], ARGV[1])`}
${DEFAULT_TTL_SECONDS > 0 ? `redis.call('SET', KEYS[3], ARGV[1], 'EX', ${DEFAULT_TTL_SECONDS})` : `redis.call('SET', KEYS[3], ARGV[1])`}
return {'restored', actualActive}
`;

const APPLY_POLICY_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if redis.call('HGET', KEYS[1], 'status') ~= 'active' then return 0 end
local previousRevision = redis.call('HGET', KEYS[1], 'appliedPolicyRevision')
if previousRevision ~= ARGV[2] then
  if ARGV[3] == 'hybrid' then
    redis.call('HSET', KEYS[1],
      'hybridPolicyRevision', ARGV[2],
      'hybridObservedCount', '0',
      'hybridStartedAt', ARGV[5])
  else
    redis.call('HDEL', KEYS[1], 'hybridPolicyRevision', 'hybridObservedCount', 'hybridStartedAt')
  end
end
redis.call('HSET', KEYS[1],
  'appliedPolicy', ARGV[1],
  'appliedPolicyRevision', ARGV[2],
  'appliedPolicyStrategy', ARGV[3],
  'updatedAt', ARGV[4])
return 1
`;

const RECORD_COMPRESSION_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end
if redis.call('HGET', KEYS[1], 'status') ~= 'active' then return {'inactive'} end
local lifetime = ''
if redis.call('HEXISTS', KEYS[1], 'compressionCount') == 1 then
  lifetime = tostring(redis.call('HINCRBY', KEYS[1], 'compressionCount', 1))
end
local appliedRevision = redis.call('HGET', KEYS[1], 'appliedPolicyRevision') or ''
local matched = appliedRevision == ARGV[1]
local hybridCount = redis.call('HGET', KEYS[1], 'hybridObservedCount') or ''
if matched and redis.call('HGET', KEYS[1], 'appliedPolicyStrategy') == 'hybrid'
  and redis.call('HGET', KEYS[1], 'hybridPolicyRevision') == ARGV[1] then
  hybridCount = tostring(redis.call('HINCRBY', KEYS[1], 'hybridObservedCount', 1))
end
redis.call('HSET', KEYS[1], 'updatedAt', ARGV[2])
return {'recorded', lifetime, hybridCount, matched and '1' or '0'}
`;

/**
 * Lua: atomic increment compressionCount with active-status CAS guard.
 * KEYS[1] = detail key, ARGV[1] = updatedAt timestamp.
 * Returns: -1 if key doesn't exist, -2 if status != 'active',
 *          otherwise the new compressionCount.
 */
const INCR_COMPRESSION_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
if redis.call('HGET', KEYS[1], 'status') ~= 'active' then return -2 end
if redis.call('HEXISTS', KEYS[1], 'compressionCount') == 0 then return -3 end
local newCount = redis.call('HINCRBY', KEYS[1], 'compressionCount', 1)
redis.call('HSET', KEYS[1], 'updatedAt', ARGV[1])
return newCount
`;

/**
 * #1382 maintainer P1: atomically merge a provenance note into the stored
 * capacityPin. The script re-reads the CURRENT pin inside the same Redis
 * execution, so a delayed writer can never undo a concurrent shrink by
 * writing back a stale pin object. Dedup lives here: an already-present note
 * is not re-appended. KEYS[1] = detail key; ARGV[1] = note; ARGV[2] =
 * updatedAt. Returns 1 when appended, 0 when skipped.
 */
const APPEND_CAPACITY_PIN_PROVENANCE_LUA = `
local data = redis.call('HGET', KEYS[1], 'capacityPin')
if not data then return 0 end
local ok, pin = pcall(cjson.decode, data)
if not ok or type(pin) ~= 'table' or type(pin['provenance']) ~= 'string' then return 0 end
if string.find(pin['provenance'], ARGV[1], 1, true) then return 0 end
-- #1382 review P2: semantic dedup — a jittered report number replaces the
-- previous recovery note in place (one pin carries at most one recovery
-- instruction) instead of growing provenance unbounded.
local pattern = "; carrier now reports [%d,]+ tokens .-seal the session to recover if this pin was polluted"
local replaced, count = string.gsub(pin['provenance'], pattern, ARGV[1], 1)
if count == 0 then
  pin['provenance'] = pin['provenance'] .. ARGV[1]
else
  pin['provenance'] = replaced
end
redis.call('HSET', KEYS[1], 'capacityPin', cjson.encode(pin), 'updatedAt', ARGV[2])
return 1
`;

/**
 * #1382 maintainer P1: atomic shrink-only pin application. The candidate is
 * written only when no usable pin is stored or its windowTokens is <= the
 * CURRENT stored pin's — a stored smaller constraint is never overwritten by
 * a delayed larger candidate. KEYS[1] = detail key; ARGV[1] = candidate JSON;
 * ARGV[2] = updatedAt. Returns 1 when written, 0 when the stored pin already
 * constrains harder, -1 when the record is missing.
 */
const SHRINK_CAPACITY_PIN_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
local data = redis.call('HGET', KEYS[1], 'capacityPin')
if data then
  local ok, current = pcall(cjson.decode, data)
  local candidate = cjson.decode(ARGV[1])
  if ok and type(current) == 'table' and type(current['windowTokens']) == 'number'
     and current['windowTokens'] > 0 and candidate['windowTokens'] > current['windowTokens'] then
    return 0
  end
end
redis.call('HSET', KEYS[1], 'capacityPin', ARGV[1], 'updatedAt', ARGV[2])
return 1
`;

export class RedisSessionChainStore implements ISessionChainStore {
  private readonly redis: RedisClient;
  private threadIndexReady = false;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const { randomUUID } = await import('node:crypto');
    const cliKey = SessionChainKeys.byCli(input.cliSessionId ?? '__unbound__');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const id = randomUUID();
      const now = String(Date.now());
      const activeKey = SessionChainKeys.active(input.catId, input.threadId);
      const chainSetKey = SessionChainKeys.chain(input.catId, input.threadId);
      const detailKey = SessionChainKeys.detail(id);
      // F198 Bug #3: chainKey index key. When input has no chainKey we still
      // pass a placeholder 5th key to keep numkeys fixed; the Lua guards on
      // ARGV[8] !== '' so the placeholder is never written.
      const chainKeyIndexKey = SessionChainKeys.byChainKey(input.chainKey ?? '__none__');
      const threadIndexKey = SessionChainKeys.byThread(input.threadId);

      const result = (await this.redis.eval(
        CREATE_LUA,
        7,
        activeKey,
        chainSetKey,
        detailKey,
        cliKey,
        chainKeyIndexKey,
        threadIndexKey,
        SessionChainKeys.activeOwner(input.userId, input.catId, input.threadId),
        id,
        input.cliSessionId ?? '',
        input.threadId,
        input.catId,
        input.userId,
        now,
        input.reuseExistingCliSession ? '1' : '0',
        input.chainKey ?? '',
        input.workingDirectory ?? '',
        input.workspaceFingerprint ?? '',
        chainSetKey,
        input.reuseExistingActive ? '1' : '0',
        input.compressionCount == null ? '' : String(input.compressionCount),
      )) as [string, string, string?];

      const [status, recordId, seqRaw] = result;
      if (status === 'existing' || status === 'existing_active') {
        const existing = await this.get(recordId);
        if (status === 'existing') {
          if (existing) return existing;
          await this.redis.eval(COMPARE_DELETE_LUA, 1, cliKey, recordId);
        } else {
          if (
            existing?.status === 'active' &&
            existing.userId === input.userId &&
            existing.catId === input.catId &&
            existing.threadId === input.threadId
          ) {
            return existing;
          }
          await this.redis.eval(
            COMPARE_DELETE_LUA,
            1,
            SessionChainKeys.activeOwner(input.userId, input.catId, input.threadId),
            recordId,
          );
        }
        continue;
      }

      const seq = Number.parseInt(seqRaw ?? '0', 10);
      return {
        id: recordId,
        ...(input.cliSessionId ? { cliSessionId: input.cliSessionId } : {}),
        threadId: input.threadId,
        catId: input.catId as CatId,
        userId: input.userId,
        seq,
        status: 'active',
        messageCount: 0,
        compressionCount: input.compressionCount ?? null,
        createdAt: parseInt(now, 10),
        updatedAt: parseInt(now, 10),
        ...(input.chainKey ? { chainKey: input.chainKey } : {}),
        ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
        ...(input.workspaceFingerprint ? { workspaceFingerprint: input.workspaceFingerprint } : {}),
      };
    }

    throw new Error(
      `stale session index could not be repaired: ${input.cliSessionId ?? `${input.catId}:${input.threadId}`}`,
    );
  }

  async getOrCreateActive(input: CreateSessionInput): Promise<SessionRecord> {
    const active = await this.getActive(input.catId, input.threadId, input.userId);
    if (active) return active;
    if (!input.cliSessionId) return this.create({ ...input, reuseExistingActive: true });

    // Ask CREATE_LUA to observe both owner and CLI indexes atomically. If the
    // runtime ID is already owned by another logical session, never reuse or
    // overwrite that record: create this owner's logical node unbound instead.
    const claimedOrCreated = await this.create({
      ...input,
      reuseExistingActive: true,
      reuseExistingCliSession: true,
    });
    if (
      claimedOrCreated.status === 'active' &&
      claimedOrCreated.userId === input.userId &&
      claimedOrCreated.catId === input.catId &&
      claimedOrCreated.threadId === input.threadId
    ) {
      return claimedOrCreated;
    }
    return this.create({
      ...input,
      cliSessionId: undefined,
      reuseExistingActive: true,
      reuseExistingCliSession: false,
    });
  }

  async bindCliSessionId(id: string, cliSessionId: string): Promise<SessionRecord | null> {
    const now = String(Date.now());
    const result = (await this.redis.eval(
      BIND_CLI_LUA,
      2,
      SessionChainKeys.detail(id),
      SessionChainKeys.byCli(cliSessionId),
      id,
      cliSessionId,
      now,
    )) as [string, string?];
    if (result[0] !== 'bound') return null;
    const oldCli = result[1];
    if (oldCli && oldCli !== cliSessionId) {
      await this.redis.eval(COMPARE_DELETE_LUA, 1, SessionChainKeys.byCli(oldCli), id);
    }
    return this.get(id);
  }

  async applyPolicySnapshot(id: string, snapshot: SessionPolicySnapshot): Promise<SessionRecord | null> {
    const result = await this.redis.eval(
      APPLY_POLICY_LUA,
      1,
      SessionChainKeys.detail(id),
      JSON.stringify(snapshot),
      snapshot.revision,
      snapshot.config.strategy,
      String(Date.now()),
      new Date().toISOString(),
    );
    return Number(result) === 1 ? this.get(id) : null;
  }

  async recordCompressionEvent(id: string, policyRevision: string): Promise<CompressionEventResult | null> {
    const result = (await this.redis.eval(
      RECORD_COMPRESSION_LUA,
      1,
      SessionChainKeys.detail(id),
      policyRevision,
      String(Date.now()),
    )) as [string, string?, string?, string?];
    if (result[0] !== 'recorded') return null;
    const record = await this.get(id);
    if (!record) return null;
    const lifetimeCount = result[1];
    const hybridCount = result[2];
    const hybridProgress =
      record.hybridProgress && hybridCount !== undefined && hybridCount !== ''
        ? { ...record.hybridProgress, observedCount: Number.parseInt(hybridCount, 10) }
        : (record.hybridProgress ?? null);
    return {
      compressionCount: lifetimeCount === undefined || lifetimeCount === '' ? null : Number.parseInt(lifetimeCount, 10),
      hybridProgress,
      revisionMatched: result[3] === '1',
    };
  }

  async transitionToSealing(
    id: string,
    reason: string,
    expectedPolicyRevision?: string,
  ): Promise<SessionRecord | null> {
    const record = await this.get(id);
    if (!record) return null;
    const result = await this.redis.eval(
      TRANSITION_TO_SEALING_LUA,
      3,
      SessionChainKeys.detail(id),
      SessionChainKeys.active(record.catId, record.threadId),
      SessionChainKeys.activeOwner(record.userId, record.catId, record.threadId),
      id,
      reason,
      String(Date.now()),
      expectedPolicyRevision ?? '',
    );
    return Number(result) === 1 ? this.get(id) : null;
  }

  async restoreActiveSession(input: RestoreActiveSessionInput): Promise<RestoreActiveSessionResult> {
    const target = await this.get(input.targetSessionId);
    if (!target) return { status: 'target_missing' };

    const expectedActiveSessionId = input.expectedActiveSessionId ?? '';
    const result = (await this.redis.eval(
      RESTORE_ACTIVE_SESSION_LUA,
      4,
      SessionChainKeys.detail(target.id),
      SessionChainKeys.active(target.catId, target.threadId),
      SessionChainKeys.activeOwner(target.userId, target.catId, target.threadId),
      SessionChainKeys.detail(expectedActiveSessionId || '__none__'),
      target.id,
      expectedActiveSessionId,
      input.displacedSealReason,
      String(Date.now()),
      target.userId,
      target.catId,
      target.threadId,
    )) as [string, string?];

    const [status, detail] = result;
    if (status === 'target_missing') return { status: 'target_missing' };
    if (status === 'target_not_restorable') {
      return {
        status: 'target_not_restorable',
        targetStatus: (detail || target.status) as SessionRecord['status'],
      };
    }
    if (status === 'active_changed') {
      return { status: 'active_changed', ...(detail ? { activeSessionId: detail } : {}) };
    }

    const restored = await this.get(target.id);
    if (!restored) return { status: 'target_missing' };
    if (status === 'already_active') return { status: 'already_active', session: restored };
    return {
      status: 'restored',
      session: restored,
      ...(detail ? { displacedSessionId: detail } : {}),
    };
  }

  async get(id: string): Promise<SessionRecord | null> {
    const data = await this.redis.hgetall(SessionChainKeys.detail(id));
    if (!data || !data.id) return null;
    return this.hydrate(data);
  }

  async getActive(catId: CatId, threadId: string, userId?: string): Promise<SessionRecord | null> {
    const activeKey = userId
      ? SessionChainKeys.activeOwner(userId, catId, threadId)
      : SessionChainKeys.active(catId, threadId);
    const activeId = await this.redis.get(activeKey);
    if (activeId) {
      const record = await this.get(activeId);
      if (record?.status === 'active' && (userId === undefined || record.userId === userId)) return record;
      await this.redis.eval(COMPARE_DELETE_LUA, 1, activeKey, activeId);
    }
    if (userId === undefined) return null;

    // Upgrade pre-#1329 records (or recover a stale owner pointer) by scanning
    // the existing durable chain once, then materializing the owner index.
    const active = [...(await this.getChain(catId, threadId, userId))]
      .reverse()
      .find((record) => record.status === 'active');
    if (!active) return null;
    if (DEFAULT_TTL_SECONDS > 0) await this.redis.set(activeKey, active.id, 'EX', DEFAULT_TTL_SECONDS);
    else await this.redis.set(activeKey, active.id);
    return active;
  }

  async getChain(catId: CatId, threadId: string, userId?: string): Promise<SessionRecord[]> {
    const ids = await this.redis.zrange(SessionChainKeys.chain(catId, threadId), 0, -1);
    if (!ids.length) return [];

    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      pipeline.hgetall(SessionChainKeys.detail(id));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const records: SessionRecord[] = [];
    for (const [err, data] of results) {
      if (err || !data) continue;
      const d = data as Record<string, string>;
      if (d.id) {
        const record = this.hydrate(d);
        if (userId === undefined || record.userId === userId) records.push(record);
      }
    }
    return records.sort((a, b) => a.seq - b.seq);
  }

  async getChainByThread(threadId: string, options?: StoreReadOptions): Promise<SessionRecord[]> {
    throwIfStoreReadAborted(options);
    await this.ensureThreadIndex(options);
    throwIfStoreReadAborted(options);
    const chainKeys = await awaitStoreRead(this.redis.smembers(SessionChainKeys.byThread(threadId)), options);

    const allIds: string[] = [];
    for (const chainKey of chainKeys) {
      throwIfStoreReadAborted(options);
      const ids = await awaitStoreRead(this.redis.zrange(chainKey, 0, -1), options);
      allIds.push(...ids);
    }
    if (!allIds.length) return [];

    const pipeline = this.redis.pipeline();
    for (const id of allIds) {
      throwIfStoreReadAborted(options);
      pipeline.hgetall(SessionChainKeys.detail(id));
    }
    const results = await awaitStoreRead(pipeline.exec(), options);
    if (!results) return [];

    const records: SessionRecord[] = [];
    for (const [err, data] of results) {
      throwIfStoreReadAborted(options);
      if (err || !data) continue;
      const d = data as Record<string, string>;
      if (d.id) records.push(this.hydrate(d));
    }
    return records.sort((a, b) => {
      if (a.catId !== b.catId) return a.catId.localeCompare(b.catId);
      return a.seq - b.seq;
    });
  }

  /**
   * Phase A shipped before the per-thread index existed. Rebuild it once per
   * store instance from the durable chain keys, then keep it current in the
   * create Lua transaction. A failed/aborted rebuild deliberately leaves the
   * flag false so the next caller retries instead of trusting a partial index.
   */
  private async ensureThreadIndex(options?: StoreReadOptions): Promise<void> {
    if (this.threadIndexReady) return;
    const chainKeys = await this.scanKeys('session-chain:*', options);
    const BATCH_SIZE = 500;
    for (let i = 0; i < chainKeys.length; i += BATCH_SIZE) {
      throwIfStoreReadAborted(options);
      const pipeline = this.redis.pipeline();
      for (const chainKey of chainKeys.slice(i, i + BATCH_SIZE)) {
        const threadId = parseThreadIdFromChainKey(chainKey);
        if (threadId) pipeline.sadd(SessionChainKeys.byThread(threadId), chainKey);
      }
      await awaitStoreRead(pipeline.exec(), options);
    }
    throwIfStoreReadAborted(options);
    this.threadIndexReady = true;
  }

  async update(id: string, patch: SessionRecordPatch): Promise<SessionRecord | null> {
    const detailKey = SessionChainKeys.detail(id);
    const exists = await this.redis.exists(detailKey);
    if (!exists) return null;

    const pairs: string[] = [];
    const deleteFields: string[] = [];
    pairs.push('updatedAt', String(patch.updatedAt ?? Date.now()));

    if (patch.cliSessionId !== undefined) {
      // Update CLI index: delete old, set new
      const oldCliId = await this.redis.hget(detailKey, 'cliSessionId');
      if (oldCliId) await this.redis.del(SessionChainKeys.byCli(oldCliId));
      if (DEFAULT_TTL_SECONDS > 0) {
        await this.redis.set(SessionChainKeys.byCli(patch.cliSessionId), id, 'EX', DEFAULT_TTL_SECONDS);
      } else {
        await this.redis.set(SessionChainKeys.byCli(patch.cliSessionId), id);
      }
      pairs.push('cliSessionId', patch.cliSessionId);
    }
    if (patch.workingDirectory !== undefined) {
      pairs.push('workingDirectory', patch.workingDirectory);
    }
    if (patch.workspaceFingerprint !== undefined) {
      pairs.push('workspaceFingerprint', patch.workspaceFingerprint);
    }

    if (patch.status !== undefined) {
      pairs.push('status', patch.status);
      const catId = await this.redis.hget(detailKey, 'catId');
      const threadId = await this.redis.hget(detailKey, 'threadId');
      const userId = await this.redis.hget(detailKey, 'userId');
      if (catId && threadId && userId) {
        const activeKey = SessionChainKeys.active(catId, threadId);
        const ownerActiveKey = SessionChainKeys.activeOwner(userId, catId, threadId);
        if (patch.status === 'active') {
          if (DEFAULT_TTL_SECONDS > 0) {
            await this.redis.set(activeKey, id, 'EX', DEFAULT_TTL_SECONDS);
            await this.redis.set(ownerActiveKey, id, 'EX', DEFAULT_TTL_SECONDS);
          } else {
            await this.redis.set(activeKey, id);
            await this.redis.set(ownerActiveKey, id);
          }
        } else {
          // A new active record may claim either pointer while this seal write
          // is in flight. Delete only if the index still names this record.
          await this.redis.eval(COMPARE_DELETE_LUA, 1, activeKey, id);
          await this.redis.eval(COMPARE_DELETE_LUA, 1, ownerActiveKey, id);
        }
      }
    }

    if (patch.contextHealth !== undefined) {
      pairs.push('contextHealth', JSON.stringify(patch.contextHealth));
    }
    if (patch.capacityPin !== undefined) {
      pairs.push('capacityPin', JSON.stringify(patch.capacityPin));
    }
    if (patch.lastUsage !== undefined) {
      pairs.push('lastUsage', JSON.stringify(patch.lastUsage));
    }
    if (patch.messageCount !== undefined) {
      pairs.push('messageCount', String(patch.messageCount));
    }
    if ('sealReason' in patch) {
      if (patch.sealReason === null) deleteFields.push('sealReason');
      else if (patch.sealReason !== undefined) pairs.push('sealReason', patch.sealReason);
    }
    if ('sealedAt' in patch) {
      if (patch.sealedAt === null) deleteFields.push('sealedAt');
      else if (patch.sealedAt !== undefined) pairs.push('sealedAt', String(patch.sealedAt));
    }
    if (patch.compressionCount !== undefined) {
      if (patch.compressionCount === null) deleteFields.push('compressionCount');
      else pairs.push('compressionCount', String(patch.compressionCount));
    }
    if ('appliedPolicy' in patch) {
      if (patch.appliedPolicy === null) {
        deleteFields.push('appliedPolicy', 'appliedPolicyRevision', 'appliedPolicyStrategy');
      } else if (patch.appliedPolicy !== undefined) {
        pairs.push(
          'appliedPolicy',
          JSON.stringify(patch.appliedPolicy),
          'appliedPolicyRevision',
          patch.appliedPolicy.revision,
          'appliedPolicyStrategy',
          patch.appliedPolicy.config.strategy,
        );
      }
    }
    if ('hybridProgress' in patch) {
      if (patch.hybridProgress === null) {
        deleteFields.push('hybridPolicyRevision', 'hybridObservedCount', 'hybridStartedAt');
      } else if (patch.hybridProgress !== undefined) {
        pairs.push(
          'hybridPolicyRevision',
          patch.hybridProgress.policyRevision,
          'hybridObservedCount',
          String(patch.hybridProgress.observedCount),
          'hybridStartedAt',
          patch.hybridProgress.startedAt,
        );
      }
    }
    if (patch.continuityCapsule !== undefined) {
      pairs.push('continuityCapsule', JSON.stringify(patch.continuityCapsule));
    }
    if (patch.consecutiveRestoreFailures !== undefined) {
      pairs.push('consecutiveRestoreFailures', String(patch.consecutiveRestoreFailures));
    }
    if (patch.latestResumeSessionId !== undefined) {
      pairs.push('latestResumeSessionId', patch.latestResumeSessionId);
    }
    if (patch.catHandoffNote !== undefined) {
      pairs.push('catHandoffNote', JSON.stringify(patch.catHandoffNote));
    }
    await this.redis.hset(detailKey, ...pairs);
    if (deleteFields.length > 0) {
      await this.redis.hdel(detailKey, ...deleteFields);
    }
    return this.get(id);
  }

  async getByCliSessionId(cliSessionId: string): Promise<SessionRecord | null> {
    const id = await this.redis.get(SessionChainKeys.byCli(cliSessionId));
    if (!id) return null;
    return this.get(id);
  }

  async getByChainKey(chainKey: string): Promise<SessionRecord | null> {
    const id = await this.redis.get(SessionChainKeys.byChainKey(chainKey));
    if (!id) return null;
    // No status filter (unlike getActive): a sealed record stays reachable so
    // a concurrent done write during a seal edge keeps its state.
    return this.get(id);
  }

  async incrementCompressionCount(id: string): Promise<number | null> {
    const detailKey = SessionChainKeys.detail(id);
    // Lua: atomic exists-check + increment in one round-trip.
    // Returns -1 if key doesn't exist, otherwise the new compressionCount.
    const result = await this.redis.eval(INCR_COMPRESSION_LUA, 1, detailKey, String(Date.now()));
    const code = result as number;
    return code < 0 ? null : code;
  }

  async appendCapacityPinProvenance(id: string, note: string): Promise<SessionRecord | null> {
    const detailKey = SessionChainKeys.detail(id);
    // Lua: atomic read-merge-write against the CURRENT stored pin (see the
    // script comment) — a concurrent shrink is never undone by stale numerics.
    const result = await this.redis.eval(APPEND_CAPACITY_PIN_PROVENANCE_LUA, 1, detailKey, note, String(Date.now()));
    if ((result as number) !== 1) return null;
    return this.get(id);
  }

  async shrinkCapacityPin(id: string, candidate: SessionCapacityPin): Promise<SessionRecord | null> {
    const detailKey = SessionChainKeys.detail(id);
    // Lua: atomic compare-and-write — the candidate lands only when it does
    // not expand beyond the CURRENT stored pin (one-way pin invariant).
    const result = await this.redis.eval(
      SHRINK_CAPACITY_PIN_LUA,
      1,
      detailKey,
      JSON.stringify(candidate),
      String(Date.now()),
    );
    if ((result as number) < 0) return null;
    return this.get(id);
  }

  async listSealingSessions(): Promise<string[]> {
    const detailKeys = await this.scanKeys('session:*');
    if (detailKeys.length === 0) return [];

    const ids: string[] = [];
    const BATCH_SIZE = 50;
    for (let i = 0; i < detailKeys.length; i += BATCH_SIZE) {
      const batch = detailKeys.slice(i, i + BATCH_SIZE);
      const pipeline = this.redis.pipeline();
      for (const key of batch) {
        pipeline.hmget(key, 'id', 'status');
      }
      const results = await pipeline.exec();
      if (!results) continue;
      for (const [err, data] of results) {
        if (err || !data) continue;
        const [id, status] = data as [string | null, string | null];
        if (id && status === 'sealing') ids.push(id);
      }
    }
    return ids;
  }

  private hydrate(data: Record<string, string>): SessionRecord {
    const contextHealth = safeParseJson<ContextHealth>(data.contextHealth);
    const capacityPin = safeParseJson<SessionCapacityPin>(data.capacityPin);
    const lastUsage = safeParseJson<SessionUsageSnapshot>(data.lastUsage);
    const continuityCapsule =
      data.continuityCapsule !== undefined ? safeParseJson<unknown>(data.continuityCapsule) : undefined;
    const catHandoffNote =
      data.catHandoffNote !== undefined ? safeParseJson<CatHandoffNote>(data.catHandoffNote) : undefined;
    const sealReason = data.sealReason as SessionRecord['sealReason'] | undefined;
    const sealedAt = data.sealedAt ? parseInt(data.sealedAt, 10) : undefined;
    const compressionCount = data.compressionCount !== undefined ? parseInt(data.compressionCount, 10) : null;
    const appliedPolicy = safeParseJson<SessionPolicySnapshot>(data.appliedPolicy);
    const hybridProgress: HybridProgress | undefined =
      data.hybridPolicyRevision && data.hybridObservedCount !== undefined && data.hybridStartedAt
        ? {
            policyRevision: data.hybridPolicyRevision,
            observedCount: parseInt(data.hybridObservedCount, 10),
            startedAt: data.hybridStartedAt,
          }
        : undefined;
    const consecutiveRestoreFailures = data.consecutiveRestoreFailures
      ? parseInt(data.consecutiveRestoreFailures, 10)
      : undefined;

    return {
      id: data.id!,
      ...(data.cliSessionId ? { cliSessionId: data.cliSessionId } : {}),
      threadId: data.threadId!,
      catId: data.catId as CatId,
      userId: data.userId!,
      ...(data.workingDirectory ? { workingDirectory: data.workingDirectory } : {}),
      ...(data.workspaceFingerprint ? { workspaceFingerprint: data.workspaceFingerprint } : {}),
      seq: parseInt(data.seq!, 10),
      status: (data.status as SessionStatus) ?? 'active',
      ...(contextHealth ? { contextHealth } : {}),
      ...(capacityPin ? { capacityPin } : {}),
      ...(lastUsage ? { lastUsage } : {}),
      messageCount: parseInt(data.messageCount ?? '0', 10),
      compressionCount,
      ...(sealReason ? { sealReason } : {}),
      ...(sealedAt ? { sealedAt } : {}),
      ...(appliedPolicy ? { appliedPolicy } : {}),
      ...(hybridProgress ? { hybridProgress } : {}),
      ...(continuityCapsule !== undefined && continuityCapsule !== null ? { continuityCapsule } : {}),
      ...(catHandoffNote !== undefined && catHandoffNote !== null ? { catHandoffNote } : {}),
      ...(consecutiveRestoreFailures !== undefined ? { consecutiveRestoreFailures } : {}),
      ...(data.chainKey ? { chainKey: data.chainKey } : {}),
      ...(data.latestResumeSessionId ? { latestResumeSessionId: data.latestResumeSessionId } : {}),
      createdAt: parseInt(data.createdAt!, 10),
      updatedAt: parseInt(data.updatedAt!, 10),
    };
  }

  /**
   * Scan for keys matching pattern.
   * IMPORTANT: ioredis scanStream / keys() does NOT auto-prefix (unlike normal commands).
   * We must manually add the keyPrefix for matching, then strip it from results
   * so that subsequent commands (which DO auto-prefix) work correctly.
   */
  private async scanKeys(pattern: string, options?: StoreReadOptions): Promise<string[]> {
    throwIfStoreReadAborted(options);
    const prefix = (this.redis.options as { keyPrefix?: string }).keyPrefix ?? '';
    const prefixedPattern = `${prefix}${pattern}`;
    return new Promise((resolve, reject) => {
      const keys: string[] = [];
      const stream = this.redis.scanStream({ match: prefixedPattern, count: 100 });
      let settled = false;
      const cleanup = (): void => {
        options?.signal?.removeEventListener('abort', onAbort);
        stream.removeListener('data', onData);
        stream.removeListener('end', onEnd);
        stream.removeListener('error', onError);
      };
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error !== undefined) reject(error);
        else resolve(keys);
      };
      const onData = (batch: string[]): void => {
        for (const k of batch) {
          // Strip prefix so subsequent auto-prefixing commands work
          const stripped = prefix && k.startsWith(prefix) ? k.slice(prefix.length) : k;
          keys.push(stripped);
        }
      };
      const onEnd = (): void => finish();
      const onError = (error: unknown): void => finish(error);
      const onAbort = (): void => {
        stream.destroy();
        finish(options?.signal?.reason);
      };
      stream.on('data', onData);
      stream.on('end', onEnd);
      stream.on('error', onError);
      options?.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

function parseThreadIdFromChainKey(chainKey: string): string | null {
  const prefix = 'session-chain:';
  if (!chainKey.startsWith(prefix)) return null;
  const catAndThread = chainKey.slice(prefix.length);
  const separator = catAndThread.indexOf(':');
  if (separator <= 0 || separator === catAndThread.length - 1) return null;
  return catAndThread.slice(separator + 1);
}

function safeParseJson<T>(value: string | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
