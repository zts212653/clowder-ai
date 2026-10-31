/**
 * Redis Push Subscription Store
 * Redis-backed push subscription persistence — 重启后订阅不丢失
 *
 * Data structures:
 * - Hash push-sub:{endpointHash} — subscription details
 * - Set push-user:{userId} — endpoint hashes for a user
 * - Set push-subs:all — all endpoint hashes
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { IPushSubscriptionStore, PushSubscriptionRecord } from '../ports/PushSubscriptionStore.js';
import { hashEndpoint, PushSubKeys } from '../redis-keys/push-keys.js';

const DEFAULT_TTL_SECONDS = 0; // persistent — set >0 via env to enable expiry

export class RedisPushSubscriptionStore implements IPushSubscriptionStore {
  private readonly redis: RedisClient;
  private readonly ttlSeconds: number | null;

  constructor(redis: RedisClient, options?: { ttlSeconds?: number }) {
    this.redis = redis;
    const raw = options?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.ttlSeconds = !Number.isFinite(raw) || raw <= 0 ? null : Math.floor(raw);
  }

  async upsert(record: PushSubscriptionRecord): Promise<void> {
    const eh = hashEndpoint(record.endpoint);
    const key = PushSubKeys.detail(eh);

    // If endpoint was previously owned by a different user, clean their user set
    const previousUserId = await this.redis.hget(key, 'userId');

    const fields = this.serialize(record);
    const pipeline = this.redis.multi();
    pipeline.hset(key, ...fields);
    if (this.ttlSeconds !== null) {
      pipeline.expire(key, this.ttlSeconds);
    }
    pipeline.sadd(PushSubKeys.ALL, eh);
    pipeline.sadd(PushSubKeys.userSet(record.userId), eh);
    if (previousUserId && previousUserId !== record.userId) {
      pipeline.srem(PushSubKeys.userSet(previousUserId), eh);
    }
    await pipeline.exec();
  }

  async remove(endpoint: string): Promise<boolean> {
    const eh = hashEndpoint(endpoint);
    const key = PushSubKeys.detail(eh);

    // Read userId before delete (needed to clean user set)
    const userId = await this.redis.hget(key, 'userId');
    const deleted = await this.redis.del(key);
    if (deleted === 0) return false;

    const pipeline = this.redis.multi();
    pipeline.srem(PushSubKeys.ALL, eh);
    if (userId) pipeline.srem(PushSubKeys.userSet(userId), eh);
    await pipeline.exec();
    return true;
  }

  async removeForUser(userId: string, endpoint: string): Promise<boolean> {
    const eh = hashEndpoint(endpoint);
    const key = PushSubKeys.detail(eh);

    // Atomic ownership check: only delete if userId matches
    const storedUserId = await this.redis.hget(key, 'userId');
    if (!storedUserId || storedUserId !== userId) return false;

    const deleted = await this.redis.del(key);
    if (deleted === 0) return false;

    const pipeline = this.redis.multi();
    pipeline.srem(PushSubKeys.ALL, eh);
    pipeline.srem(PushSubKeys.userSet(userId), eh);
    await pipeline.exec();
    return true;
  }

  async listByUser(userId: string): Promise<PushSubscriptionRecord[]> {
    const hashes = await this.redis.smembers(PushSubKeys.userSet(userId));
    if (hashes.length === 0) return [];
    return this.fetchByHashes(hashes, PushSubKeys.userSet(userId));
  }

  async listAll(): Promise<PushSubscriptionRecord[]> {
    const hashes = await this.redis.smembers(PushSubKeys.ALL);
    if (hashes.length === 0) return [];
    return this.fetchByHashes(hashes, PushSubKeys.ALL);
  }

  private async fetchByHashes(hashes: string[], sourceSetKey: string): Promise<PushSubscriptionRecord[]> {
    const pipeline = this.redis.pipeline();
    for (const eh of hashes) {
      pipeline.hgetall(PushSubKeys.detail(eh));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const records: PushSubscriptionRecord[] = [];
    const staleHashes: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const [err, data] = results[i]!;
      if (err || !data || typeof data !== 'object') {
        staleHashes.push(hashes[i]!);
        continue;
      }
      const d = data as Record<string, string>;
      if (!d.endpoint) {
        // Detail hash expired (TTL) but set entries remain — mark for cleanup
        staleHashes.push(hashes[i]!);
        continue;
      }
      records.push(this.hydrate(d));
    }

    // Self-heal: remove stale entries from ALL index sets (TTL-expired detail hashes)
    if (staleHashes.length > 0) {
      const cleanup = this.redis.pipeline();
      for (const eh of staleHashes) {
        // Always clean the global set
        cleanup.srem(PushSubKeys.ALL, eh);
        // Also clean the caller's set if it's not the global one (e.g. user set)
        if (sourceSetKey !== PushSubKeys.ALL) {
          cleanup.srem(sourceSetKey, eh);
        }
      }
      cleanup.exec().catch(() => {
        /* best-effort cleanup */
      });
    }

    return records;
  }

  private serialize(record: PushSubscriptionRecord): string[] {
    const fields: string[] = [
      'endpoint',
      record.endpoint,
      'p256dh',
      record.keys.p256dh,
      'auth',
      record.keys.auth,
      'userId',
      record.userId,
      'createdAt',
      String(record.createdAt),
    ];
    if (record.userAgent) fields.push('userAgent', record.userAgent);
    return fields;
  }

  private hydrate(data: Record<string, string>): PushSubscriptionRecord {
    return {
      endpoint: data.endpoint!,
      keys: {
        p256dh: data.p256dh!,
        auth: data.auth!,
      },
      userId: data.userId!,
      createdAt: parseInt(data.createdAt!, 10),
      ...(data.userAgent ? { userAgent: data.userAgent } : {}),
    };
  }
}
