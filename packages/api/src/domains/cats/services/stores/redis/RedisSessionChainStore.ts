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

import type { CatId, ContextHealth, SessionRecord, SessionStatus, SessionUsageSnapshot } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { CreateSessionInput, ISessionChainStore, SessionRecordPatch } from '../ports/SessionChainStore.js';
import { SessionChainKeys } from '../redis-keys/session-chain-keys.js';

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Lua: atomic create session record.
 * KEYS[1] = active key, KEYS[2] = chain key, KEYS[3] = detail key, KEYS[4] = cli key
 * ARGV[1] = id, ARGV[2] = cliSessionId, ARGV[3] = threadId, ARGV[4] = catId,
 * ARGV[5] = userId, ARGV[6] = now
 *
 * Returns next seq number.
 */
const CREATE_LUA = `
local seq = redis.call('ZCARD', KEYS[2])
redis.call('HSET', KEYS[3],
  'id', ARGV[1], 'cliSessionId', ARGV[2], 'threadId', ARGV[3],
  'catId', ARGV[4], 'userId', ARGV[5], 'seq', tostring(seq),
  'status', 'active', 'messageCount', '0',
  'createdAt', ARGV[6], 'updatedAt', ARGV[6])
redis.call('EXPIRE', KEYS[3], ${DEFAULT_TTL_SECONDS})
redis.call('ZADD', KEYS[2], seq, ARGV[1])
redis.call('EXPIRE', KEYS[2], ${DEFAULT_TTL_SECONDS})
redis.call('SET', KEYS[1], ARGV[1], 'EX', ${DEFAULT_TTL_SECONDS})
redis.call('SET', KEYS[4], ARGV[1], 'EX', ${DEFAULT_TTL_SECONDS})
return seq
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
    const id = randomUUID();
    const now = String(Date.now());

    const activeKey = SessionChainKeys.active(input.catId, input.threadId);
    const chainKey = SessionChainKeys.chain(input.catId, input.threadId);
    const detailKey = SessionChainKeys.detail(id);
    const cliKey = SessionChainKeys.byCli(input.cliSessionId);

    const seq = (await this.redis.eval(
      CREATE_LUA,
      4,
      activeKey,
      chainKey,
      detailKey,
      cliKey,
      id,
      input.cliSessionId,
      input.threadId,
      input.catId,
      input.userId,
      now,
    )) as number;

    return {
      id,
      cliSessionId: input.cliSessionId,
      threadId: input.threadId,
      catId: input.catId as CatId,
      userId: input.userId,
      seq,
      status: 'active',
      messageCount: 0,
      createdAt: parseInt(now, 10),
      updatedAt: parseInt(now, 10),
    };
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
    pairs.push('updatedAt', String(patch.updatedAt ?? Date.now()));

    if (patch.cliSessionId !== undefined) {
      // Update CLI index: delete old, set new
      const oldCliId = await this.redis.hget(detailKey, 'cliSessionId');
      if (oldCliId) await this.redis.del(SessionChainKeys.byCli(oldCliId));
      await this.redis.set(SessionChainKeys.byCli(patch.cliSessionId), id, 'EX', DEFAULT_TTL_SECONDS);
      pairs.push('cliSessionId', patch.cliSessionId);
    }

    if (patch.status !== undefined) {
      pairs.push('status', patch.status);
      // Remove from active index if no longer active
      if (patch.status !== 'active') {
        const catId = await this.redis.hget(detailKey, 'catId');
        const threadId = await this.redis.hget(detailKey, 'threadId');
        if (catId && threadId) {
          const activeKey = SessionChainKeys.active(catId, threadId);
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
    if (patch.sealReason !== undefined) {
      pairs.push('sealReason', patch.sealReason);
    }
    if (patch.sealedAt !== undefined) {
      pairs.push('sealedAt', String(patch.sealedAt));
    }
    if (patch.compressionCount !== undefined) {
      pairs.push('compressionCount', String(patch.compressionCount));
    }
    if (patch.consecutiveRestoreFailures !== undefined) {
      pairs.push('consecutiveRestoreFailures', String(patch.consecutiveRestoreFailures));
    }

    await this.redis.hset(detailKey, ...pairs);
    return this.get(id);
  }

  async getByCliSessionId(cliSessionId: string): Promise<SessionRecord | null> {
    const id = await this.redis.get(SessionChainKeys.byCli(cliSessionId));
    if (!id) return null;
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
      seq: parseInt(data.seq!, 10),
      status: (data.status as SessionStatus) ?? 'active',
      ...(contextHealth ? { contextHealth } : {}),
      ...(lastUsage ? { lastUsage } : {}),
      messageCount: parseInt(data.messageCount ?? '0', 10),
      ...(sealReason ? { sealReason } : {}),
      ...(sealedAt ? { sealedAt } : {}),
      ...(compressionCount !== undefined ? { compressionCount } : {}),
      ...(consecutiveRestoreFailures !== undefined ? { consecutiveRestoreFailures } : {}),
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
