/**
 * Redis Pending Request Store
 * Redis-backed pending queue — 铲屎官离线时请求不丢失
 *
 * Data structures:
 * - Hash pending-req:{requestId} — request details
 * - SortedSet pending-reqs:all — all IDs scored by createdAt
 * - SortedSet pending-reqs:waiting — waiting-only IDs (removed on respond)
 *
 * IMPORTANT: ioredis keyPrefix auto-prefixes ALL commands.
 */

import type { CatId, PendingRequestRecord, RespondScope } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { generateSortableId } from '../ports/MessageStore.js';
import type { CreatePendingInput, IPendingRequestStore } from '../ports/PendingRequestStore.js';
import { PendingReqKeys } from '../redis-keys/authorization-keys.js';

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const DEFAULT_MAX = 1000;

/**
 * Lua CAS respond: atomically check status='waiting' → update fields + ZREM from waiting set.
 * KEYS[1] = pending-req:{requestId} hash
 * KEYS[2] = pending-reqs:waiting sorted set
 * ARGV[1] = requestId (for ZREM)
 * ARGV[2..N] = field/value pairs to HSET
 *
 * Returns 1 on success, 0 if status is not 'waiting' (already responded or missing).
 *
 * IMPORTANT: ioredis keyPrefix auto-prefixes KEYS[].
 */
const CAS_RESPOND_LUA = `
local current = redis.call('HGET', KEYS[1], 'status')
if current ~= 'waiting' then
  return 0
end
local fields = {}
for i = 2, #ARGV do
  fields[#fields + 1] = ARGV[i]
end
if #fields > 0 then
  redis.call('HSET', KEYS[1], unpack(fields))
end
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

export class RedisPendingRequestStore implements IPendingRequestStore {
  private readonly redis: RedisClient;
  private readonly ttlSeconds: number | null;
  private readonly maxRecords: number;

  constructor(redis: RedisClient, options?: { ttlSeconds?: number; maxRecords?: number }) {
    this.redis = redis;
    this.maxRecords = options?.maxRecords ?? DEFAULT_MAX;
    const ttl = options?.ttlSeconds;
    if (ttl === undefined) {
      this.ttlSeconds = DEFAULT_TTL_SECONDS;
    } else if (!Number.isFinite(ttl) || ttl <= 0) {
      this.ttlSeconds = null;
    } else {
      this.ttlSeconds = Math.floor(ttl);
    }
  }

  async create(input: CreatePendingInput): Promise<PendingRequestRecord> {
    await this.evictIfFull();

    const now = Date.now();
    const record: PendingRequestRecord = {
      requestId: generateSortableId(now),
      invocationId: input.invocationId,
      catId: input.catId,
      threadId: input.threadId,
      action: input.action,
      reason: input.reason,
      ...(input.context ? { context: input.context } : {}),
      createdAt: now,
      status: 'waiting',
    };

    const key = PendingReqKeys.detail(record.requestId);
    const fields = this.serializeRecord(record);
    const pipeline = this.redis.multi();
    pipeline.hset(key, ...fields);
    if (this.ttlSeconds) pipeline.expire(key, this.ttlSeconds);
    pipeline.zadd(PendingReqKeys.ALL, String(now), record.requestId);
    pipeline.zadd(PendingReqKeys.WAITING, String(now), record.requestId);
    await pipeline.exec();

    return record;
  }

  async get(requestId: string): Promise<PendingRequestRecord | null> {
    const key = PendingReqKeys.detail(requestId);
    const data = await this.redis.hgetall(key);
    if (!data || !data.requestId) return null;
    return this.hydrateRecord(data);
  }

  async respond(
    requestId: string,
    decision: 'granted' | 'denied',
    scope: RespondScope,
    reason?: string,
  ): Promise<PendingRequestRecord | null> {
    const now = Date.now();
    const key = PendingReqKeys.detail(requestId);

    // Build field/value pairs for atomic HSET inside Lua
    const pairs: string[] = ['status', decision, 'respondedAt', String(now), 'respondScope', scope];
    if (reason) pairs.push('respondReason', reason);

    // Lua CAS: atomically check status='waiting' → HSET + ZREM
    const ok = (await this.redis.eval(CAS_RESPOND_LUA, 2, key, PendingReqKeys.WAITING, requestId, ...pairs)) as number;

    if (ok === 0) return null;

    // Re-read full record from Redis to return complete state
    return this.get(requestId);
  }

  async listWaiting(threadId?: string): Promise<PendingRequestRecord[]> {
    // Fetch waiting IDs (oldest first = ascending score)
    const ids = await this.redis.zrange(PendingReqKeys.WAITING, 0, -1);
    if (ids.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      pipeline.hgetall(PendingReqKeys.detail(id));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const records: PendingRequestRecord[] = [];
    for (const [err, data] of results) {
      if (err || !data || typeof data !== 'object') continue;
      const d = data as Record<string, string>;
      if (!d.requestId) continue;
      const record = this.hydrateRecord(d);
      if (record.status !== 'waiting') continue;
      if (threadId && record.threadId !== threadId) continue;
      records.push(record);
    }

    return records.sort((a, b) => a.createdAt - b.createdAt);
  }

  private async evictIfFull(): Promise<void> {
    const count = await this.redis.zcard(PendingReqKeys.ALL);
    if (count < this.maxRecords) return;

    // Try evicting a resolved record first (not in WAITING set)
    const allIds = await this.redis.zrange(PendingReqKeys.ALL, 0, 0);
    if (allIds.length > 0) {
      const oldest = allIds[0]!;
      const isWaiting = await this.redis.zscore(PendingReqKeys.WAITING, oldest);
      if (isWaiting === null) {
        // Resolved — safe to evict
        await this.redis.del(PendingReqKeys.detail(oldest));
        await this.redis.zrem(PendingReqKeys.ALL, oldest);
        return;
      }
      // All are waiting — evict oldest anyway
      await this.redis.del(PendingReqKeys.detail(oldest));
      await this.redis.zrem(PendingReqKeys.ALL, oldest);
      await this.redis.zrem(PendingReqKeys.WAITING, oldest);
    }
  }

  private serializeRecord(record: PendingRequestRecord): string[] {
    const fields: string[] = [
      'requestId',
      record.requestId,
      'invocationId',
      record.invocationId,
      'catId',
      record.catId,
      'threadId',
      record.threadId,
      'action',
      record.action,
      'reason',
      record.reason,
      'createdAt',
      String(record.createdAt),
      'status',
      record.status,
    ];
    if (record.context) fields.push('context', record.context);
    if (record.respondedAt) fields.push('respondedAt', String(record.respondedAt));
    if (record.respondReason) fields.push('respondReason', record.respondReason);
    if (record.respondScope) fields.push('respondScope', record.respondScope);
    return fields;
  }

  private hydrateRecord(data: Record<string, string>): PendingRequestRecord {
    return {
      requestId: data.requestId!,
      invocationId: data.invocationId!,
      catId: data.catId! as CatId,
      threadId: data.threadId!,
      action: data.action!,
      reason: data.reason!,
      createdAt: parseInt(data.createdAt!, 10),
      status: data.status! as 'waiting' | 'granted' | 'denied',
      ...(data.context ? { context: data.context } : {}),
      ...(data.respondedAt ? { respondedAt: parseInt(data.respondedAt, 10) } : {}),
      ...(data.respondReason ? { respondReason: data.respondReason } : {}),
      ...(data.respondScope ? { respondScope: data.respondScope as RespondScope } : {}),
    };
  }
}
