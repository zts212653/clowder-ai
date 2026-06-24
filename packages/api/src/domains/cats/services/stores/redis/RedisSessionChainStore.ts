/**
 * Redis Session Chain Store
 * F24: Redis-backed session chain storage.
 *
 * Data model:
 * - Hash per session record (session:{id})
 * - Sorted Set per cat+thread chain (session-chain:{catId}:{threadId}, score=seq)
 * - String for active index (session-active:{catId}:{threadId} → id)
 * - String for CLI index (session-cli:{cliSessionId} → id)
 *
 * IMPORTANT: ioredis keyPrefix auto-prefixes ALL commands including eval() KEYS[].
 * Pass bare keys only.
 */

import type {
  CatHandoffNote,
  CatId,
  ContextHealth,
  SessionRecord,
  SessionStatus,
  SessionUsageSnapshot,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { CreateSessionInput, ISessionChainStore, SessionRecordPatch } from '../ports/SessionChainStore.js';
import { SessionChainKeys } from '../redis-keys/session-chain-keys.js';

const DEFAULT_TTL_SECONDS = 0; // persistent — set >0 via env to enable expiry

/**
 * Lua: atomic create session record.
 * KEYS[1] = active key, KEYS[2] = chain key, KEYS[3] = detail key,
 * KEYS[4] = cli key, KEYS[5] = chainKey index key (F198; dummy when no chainKey)
 * ARGV[1] = id, ARGV[2] = cliSessionId, ARGV[3] = threadId, ARGV[4] = catId,
 * ARGV[5] = userId, ARGV[6] = now, ARGV[7] = reuseExistingCliSession flag,
 * ARGV[8] = chainKey value ('' = none, KEYS[5] left untouched)
 * ARGV[9] = workingDirectory ('' = none), ARGV[10] = workspaceFingerprint ('' = none)
 *
 * Returns: {'existing', existingId} when cliSessionId is already claimed,
 *          {'created', id, seq} when a new record is created.
 */
const CREATE_LUA = `
if ARGV[7] == '1' then
  local existingId = redis.call('GET', KEYS[4])
  if existingId then return {'existing', existingId} end
end
local seq = redis.call('ZCARD', KEYS[2])
redis.call('HSET', KEYS[3],
  'id', ARGV[1], 'cliSessionId', ARGV[2], 'threadId', ARGV[3],
  'catId', ARGV[4], 'userId', ARGV[5], 'seq', tostring(seq),
  'status', 'active', 'messageCount', '0',
  'createdAt', ARGV[6], 'updatedAt', ARGV[6])
if ARGV[8] ~= '' then
  redis.call('HSET', KEYS[3], 'chainKey', ARGV[8])
  ${DEFAULT_TTL_SECONDS > 0 ? `redis.call('SET', KEYS[5], ARGV[1], 'EX', ${DEFAULT_TTL_SECONDS})` : `redis.call('SET', KEYS[5], ARGV[1])`}
end
if ARGV[9] ~= '' then redis.call('HSET', KEYS[3], 'workingDirectory', ARGV[9]) end
if ARGV[10] ~= '' then redis.call('HSET', KEYS[3], 'workspaceFingerprint', ARGV[10]) end
${DEFAULT_TTL_SECONDS > 0 ? `redis.call('EXPIRE', KEYS[3], ${DEFAULT_TTL_SECONDS})` : '-- persistent mode: no EXPIRE'}
redis.call('ZADD', KEYS[2], seq, ARGV[1])
${DEFAULT_TTL_SECONDS > 0 ? `redis.call('EXPIRE', KEYS[2], ${DEFAULT_TTL_SECONDS})` : '-- persistent mode: no EXPIRE'}
${DEFAULT_TTL_SECONDS > 0 ? `redis.call('SET', KEYS[1], ARGV[1], 'EX', ${DEFAULT_TTL_SECONDS})` : `redis.call('SET', KEYS[1], ARGV[1])`}
${DEFAULT_TTL_SECONDS > 0 ? `redis.call('SET', KEYS[4], ARGV[1], 'EX', ${DEFAULT_TTL_SECONDS})` : `redis.call('SET', KEYS[4], ARGV[1])`}
return {'created', ARGV[1], tostring(seq)}
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
local newCount = redis.call('HINCRBY', KEYS[1], 'compressionCount', 1)
redis.call('HSET', KEYS[1], 'updatedAt', ARGV[1])
return newCount
`;

export class RedisSessionChainStore implements ISessionChainStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const { randomUUID } = await import('node:crypto');
    const cliKey = SessionChainKeys.byCli(input.cliSessionId);

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

      const result = (await this.redis.eval(
        CREATE_LUA,
        5,
        activeKey,
        chainSetKey,
        detailKey,
        cliKey,
        chainKeyIndexKey,
        id,
        input.cliSessionId,
        input.threadId,
        input.catId,
        input.userId,
        now,
        input.reuseExistingCliSession ? '1' : '0',
        input.chainKey ?? '',
        input.workingDirectory ?? '',
        input.workspaceFingerprint ?? '',
      )) as [string, string, string?];

      const [status, recordId, seqRaw] = result;
      if (status === 'existing') {
        const existing = await this.get(recordId);
        if (existing) return existing;
        await this.redis.del(cliKey);
        continue;
      }

      const seq = Number.parseInt(seqRaw ?? '0', 10);
      return {
        id: recordId,
        cliSessionId: input.cliSessionId,
        threadId: input.threadId,
        catId: input.catId as CatId,
        userId: input.userId,
        seq,
        status: 'active',
        messageCount: 0,
        createdAt: parseInt(now, 10),
        updatedAt: parseInt(now, 10),
        ...(input.chainKey ? { chainKey: input.chainKey } : {}),
        ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
        ...(input.workspaceFingerprint ? { workspaceFingerprint: input.workspaceFingerprint } : {}),
      };
    }

    throw new Error(`stale CLI session index could not be repaired: ${input.cliSessionId}`);
  }

  async get(id: string): Promise<SessionRecord | null> {
    const data = await this.redis.hgetall(SessionChainKeys.detail(id));
    if (!data || !data.id) return null;
    return this.hydrate(data);
  }

  async getActive(catId: CatId, threadId: string): Promise<SessionRecord | null> {
    const activeId = await this.redis.get(SessionChainKeys.active(catId, threadId));
    if (!activeId) return null;
    const record = await this.get(activeId);
    if (!record || record.status !== 'active') return null;
    return record;
  }

  async getChain(catId: CatId, threadId: string): Promise<SessionRecord[]> {
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
      if (d.id) records.push(this.hydrate(d));
    }
    return records.sort((a, b) => a.seq - b.seq);
  }

  async getChainByThread(threadId: string): Promise<SessionRecord[]> {
    // Scan for all session-chain:*:{threadId} keys
    // Since we can't easily enumerate by threadId with sorted sets,
    // we use a secondary approach: scan detail hashes.
    // For Phase A this is acceptable (low volume); Phase B+ can add a thread index.
    const pattern = `session-chain:*:${threadId}`;
    const chainKeys = await this.scanKeys(pattern);

    const allIds: string[] = [];
    for (const chainKey of chainKeys) {
      const ids = await this.redis.zrange(chainKey, 0, -1);
      allIds.push(...ids);
    }
    if (!allIds.length) return [];

    const pipeline = this.redis.pipeline();
    for (const id of allIds) {
      pipeline.hgetall(SessionChainKeys.detail(id));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const records: SessionRecord[] = [];
    for (const [err, data] of results) {
      if (err || !data) continue;
      const d = data as Record<string, string>;
      if (d.id) records.push(this.hydrate(d));
    }
    return records.sort((a, b) => {
      if (a.catId !== b.catId) return a.catId.localeCompare(b.catId);
      return a.seq - b.seq;
    });
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
      if (catId && threadId) {
        const activeKey = SessionChainKeys.active(catId, threadId);
        if (patch.status === 'active') {
          if (DEFAULT_TTL_SECONDS > 0) {
            await this.redis.set(activeKey, id, 'EX', DEFAULT_TTL_SECONDS);
          } else {
            await this.redis.set(activeKey, id);
          }
        } else {
          const currentActive = await this.redis.get(activeKey);
          if (currentActive === id) {
            await this.redis.del(activeKey);
          }
        }
      }
    }

    if (patch.contextHealth !== undefined) {
      pairs.push('contextHealth', JSON.stringify(patch.contextHealth));
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
      pairs.push('compressionCount', String(patch.compressionCount));
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
    const lastUsage = safeParseJson<SessionUsageSnapshot>(data.lastUsage);
    const continuityCapsule =
      data.continuityCapsule !== undefined ? safeParseJson<unknown>(data.continuityCapsule) : undefined;
    const catHandoffNote =
      data.catHandoffNote !== undefined ? safeParseJson<CatHandoffNote>(data.catHandoffNote) : undefined;
    const sealReason = data.sealReason as SessionRecord['sealReason'] | undefined;
    const sealedAt = data.sealedAt ? parseInt(data.sealedAt, 10) : undefined;
    const compressionCount = data.compressionCount ? parseInt(data.compressionCount, 10) : undefined;
    const consecutiveRestoreFailures = data.consecutiveRestoreFailures
      ? parseInt(data.consecutiveRestoreFailures, 10)
      : undefined;

    return {
      id: data.id!,
      cliSessionId: data.cliSessionId!,
      threadId: data.threadId!,
      catId: data.catId as CatId,
      userId: data.userId!,
      ...(data.workingDirectory ? { workingDirectory: data.workingDirectory } : {}),
      ...(data.workspaceFingerprint ? { workspaceFingerprint: data.workspaceFingerprint } : {}),
      seq: parseInt(data.seq!, 10),
      status: (data.status as SessionStatus) ?? 'active',
      ...(contextHealth ? { contextHealth } : {}),
      ...(lastUsage ? { lastUsage } : {}),
      messageCount: parseInt(data.messageCount ?? '0', 10),
      ...(sealReason ? { sealReason } : {}),
      ...(sealedAt ? { sealedAt } : {}),
      ...(compressionCount !== undefined ? { compressionCount } : {}),
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
  private async scanKeys(pattern: string): Promise<string[]> {
    const prefix = (this.redis.options as { keyPrefix?: string }).keyPrefix ?? '';
    const prefixedPattern = `${prefix}${pattern}`;
    return new Promise((resolve, reject) => {
      const keys: string[] = [];
      const stream = this.redis.scanStream({ match: prefixedPattern, count: 100 });
      stream.on('data', (batch: string[]) => {
        for (const k of batch) {
          // Strip prefix so subsequent auto-prefixing commands work
          const stripped = prefix && k.startsWith(prefix) ? k.slice(prefix.length) : k;
          keys.push(stripped);
        }
      });
      stream.on('end', () => resolve(keys));
      stream.on('error', reject);
    });
  }
}

function safeParseJson<T>(value: string | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
