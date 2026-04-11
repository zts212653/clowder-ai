/**
 * Redis Authorization Audit Store
 * Redis-backed audit log — 所有授权事件持久化记录
 *
 * Data structures:
 * - Hash auth-audit:{id} — audit entry details
 * - SortedSet auth-audit:all — all IDs scored by createdAt
 *
 * IMPORTANT: ioredis keyPrefix auto-prefixes ALL commands.
 */

import type { AuthorizationAuditEntry, CatId, RespondScope } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { CreateAuditInput, IAuthorizationAuditStore } from '../ports/AuthorizationAuditStore.js';
import { generateSortableId } from '../ports/MessageStore.js';
import { AuthAuditKeys } from '../redis-keys/authorization-keys.js';

const DEFAULT_TTL_SECONDS = 0; // persistent — set >0 via env to enable expiry
const DEFAULT_MAX = 5000;

export class RedisAuthorizationAuditStore implements IAuthorizationAuditStore {
  private readonly redis: RedisClient;
  private readonly ttlSeconds: number | null;
  private readonly maxEntries: number;

  constructor(redis: RedisClient, options?: { ttlSeconds?: number; maxEntries?: number }) {
    this.redis = redis;
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX;
    const ttl = options?.ttlSeconds;
    if (ttl === undefined) {
      this.ttlSeconds = DEFAULT_TTL_SECONDS;
    } else if (!Number.isFinite(ttl) || ttl <= 0) {
      this.ttlSeconds = null;
    } else {
      this.ttlSeconds = Math.floor(ttl);
    }
  }

  async append(input: CreateAuditInput): Promise<AuthorizationAuditEntry> {
    await this.evictIfFull();

    const now = Date.now();
    const entry: AuthorizationAuditEntry = {
      ...input,
      id: generateSortableId(now),
      createdAt: now,
      ...(input.decidedBy ? { decidedAt: now } : {}),
    };

    const key = AuthAuditKeys.detail(entry.id);
    const fields = this.serializeEntry(entry);
    const pipeline = this.redis.multi();
    pipeline.hset(key, ...fields);
    if (this.ttlSeconds) pipeline.expire(key, this.ttlSeconds);
    pipeline.zadd(AuthAuditKeys.ALL, String(now), entry.id);
    await pipeline.exec();

    return entry;
  }

  async list(filter?: { catId?: CatId; threadId?: string; limit?: number }): Promise<AuthorizationAuditEntry[]> {
    const limit = filter?.limit ?? 100;

    // Fetch all IDs newest-first, then filter + limit in app layer
    const allIds = await this.redis.zrevrange(AuthAuditKeys.ALL, 0, -1);
    if (allIds.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const id of allIds) {
      pipeline.hgetall(AuthAuditKeys.detail(id));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const entries: AuthorizationAuditEntry[] = [];
    for (const [err, data] of results) {
      if (err || !data || typeof data !== 'object') continue;
      const d = data as Record<string, string>;
      if (!d.id) continue;

      const entry = this.hydrateEntry(d);
      if (filter?.catId && entry.catId !== filter.catId) continue;
      if (filter?.threadId && entry.threadId !== filter.threadId) continue;
      entries.push(entry);
      if (entries.length >= limit) break;
    }

    return entries;
  }

  private async evictIfFull(): Promise<void> {
    const count = await this.redis.zcard(AuthAuditKeys.ALL);
    if (count < this.maxEntries) return;

    // Slice to 80%: remove oldest 20%
    const removeCount = count - Math.floor(this.maxEntries * 0.8);
    if (removeCount <= 0) return;

    const toRemove = await this.redis.zrange(AuthAuditKeys.ALL, 0, removeCount - 1);
    if (toRemove.length === 0) return;

    const pipeline = this.redis.pipeline();
    for (const id of toRemove) {
      pipeline.del(AuthAuditKeys.detail(id));
    }
    pipeline.zremrangebyrank(AuthAuditKeys.ALL, 0, removeCount - 1);
    await pipeline.exec();
  }

  private serializeEntry(entry: AuthorizationAuditEntry): string[] {
    const fields: string[] = [
      'id',
      entry.id,
      'requestId',
      entry.requestId,
      'invocationId',
      entry.invocationId,
      'catId',
      entry.catId,
      'threadId',
      entry.threadId,
      'action',
      entry.action,
      'reason',
      entry.reason,
      'decision',
      entry.decision,
      'createdAt',
      String(entry.createdAt),
    ];
    if (entry.scope) fields.push('scope', entry.scope);
    if (entry.decidedBy) fields.push('decidedBy', entry.decidedBy);
    if (entry.decidedAt) fields.push('decidedAt', String(entry.decidedAt));
    if (entry.matchedRuleId) fields.push('matchedRuleId', entry.matchedRuleId);
    return fields;
  }

  private hydrateEntry(data: Record<string, string>): AuthorizationAuditEntry {
    return {
      id: data.id!,
      requestId: data.requestId!,
      invocationId: data.invocationId!,
      catId: data.catId! as CatId,
      threadId: data.threadId!,
      action: data.action!,
      reason: data.reason!,
      decision: data.decision! as 'allow' | 'deny' | 'pending',
      createdAt: parseInt(data.createdAt!, 10),
      ...(data.scope ? { scope: data.scope as RespondScope } : {}),
      ...(data.decidedBy ? { decidedBy: data.decidedBy } : {}),
      ...(data.decidedAt ? { decidedAt: parseInt(data.decidedAt, 10) } : {}),
      ...(data.matchedRuleId ? { matchedRuleId: data.matchedRuleId } : {}),
    };
  }
}
