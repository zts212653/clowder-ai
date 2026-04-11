/**
 * Redis Authorization Rule Store
 * Redis-backed rule persistence — 进程重启后规则不丢失
 *
 * Data structures:
 * - Hash auth-rule:{id} — rule details
 * - SortedSet auth-rules:all — all rule IDs scored by createdAt
 *
 * IMPORTANT: ioredis keyPrefix auto-prefixes ALL commands including eval() KEYS[].
 */

import type { AuthorizationRule, CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { IAuthorizationRuleStore } from '../ports/AuthorizationRuleStore.js';
import { generateSortableId } from '../ports/MessageStore.js';
import { AuthRuleKeys } from '../redis-keys/authorization-keys.js';

/** Simple glob-style match: 'git_*' matches 'git_commit' */
function matchAction(pattern: string, action: string): boolean {
  if (pattern === '*') return true;
  if (pattern === action) return true;
  if (pattern.endsWith('*')) {
    return action.startsWith(pattern.slice(0, -1));
  }
  return false;
}

const DEFAULT_TTL_SECONDS = 0; // persistent — set >0 via env to enable expiry
const DEFAULT_MAX_RULES = 500;

export class RedisAuthorizationRuleStore implements IAuthorizationRuleStore {
  private readonly redis: RedisClient;
  private readonly ttlSeconds: number | null;
  private readonly maxRules: number;

  constructor(redis: RedisClient, options?: { ttlSeconds?: number; maxRules?: number }) {
    this.redis = redis;
    this.maxRules = options?.maxRules ?? DEFAULT_MAX_RULES;
    const ttl = options?.ttlSeconds;
    if (ttl === undefined) {
      this.ttlSeconds = DEFAULT_TTL_SECONDS;
    } else if (!Number.isFinite(ttl) || ttl <= 0) {
      this.ttlSeconds = null;
    } else {
      this.ttlSeconds = Math.floor(ttl);
    }
  }

  async add(input: Omit<AuthorizationRule, 'id' | 'createdAt'>): Promise<AuthorizationRule> {
    await this.evictIfFull();

    const now = Date.now();
    const rule: AuthorizationRule = {
      ...input,
      id: generateSortableId(now),
      createdAt: now,
    };

    const key = AuthRuleKeys.detail(rule.id);
    const fields = this.serializeRule(rule);
    const pipeline = this.redis.multi();
    pipeline.hset(key, ...fields);
    if (this.ttlSeconds) pipeline.expire(key, this.ttlSeconds);
    pipeline.zadd(AuthRuleKeys.ALL, String(now), rule.id);
    await pipeline.exec();

    return rule;
  }

  async remove(ruleId: string): Promise<boolean> {
    const key = AuthRuleKeys.detail(ruleId);
    const deleted = await this.redis.del(key);
    await this.redis.zrem(AuthRuleKeys.ALL, ruleId);
    return deleted > 0;
  }

  async match(catId: CatId, action: string, threadId: string): Promise<AuthorizationRule | null> {
    // Fetch all rule IDs (newest first for efficiency — latest wins within scope)
    const ruleIds = await this.redis.zrevrange(AuthRuleKeys.ALL, 0, -1);
    if (ruleIds.length === 0) return null;

    let bestThread: AuthorizationRule | null = null;
    let bestGlobal: AuthorizationRule | null = null;

    // Fetch rules in batches using pipeline
    const pipeline = this.redis.pipeline();
    for (const id of ruleIds) {
      pipeline.hgetall(AuthRuleKeys.detail(id));
    }
    const results = await pipeline.exec();
    if (!results) return null;

    for (const [err, data] of results) {
      if (err || !data || typeof data !== 'object') continue;
      const record = data as Record<string, string>;
      if (!record.id) continue;

      const rule = this.hydrateRule(record);
      const catMatch = rule.catId === '*' || rule.catId === catId;
      if (!catMatch) continue;
      if (!matchAction(rule.action, action)) continue;

      if (rule.scope === 'thread' && rule.threadId === threadId) {
        if (!bestThread || rule.createdAt > bestThread.createdAt) {
          bestThread = rule;
        }
      } else if (rule.scope === 'global') {
        if (!bestGlobal || rule.createdAt > bestGlobal.createdAt) {
          bestGlobal = rule;
        }
      }
    }

    return bestThread ?? bestGlobal ?? null;
  }

  async list(filter?: { catId?: CatId; threadId?: string }): Promise<AuthorizationRule[]> {
    const ruleIds = await this.redis.zrevrange(AuthRuleKeys.ALL, 0, -1);
    if (ruleIds.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const id of ruleIds) {
      pipeline.hgetall(AuthRuleKeys.detail(id));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const rules: AuthorizationRule[] = [];
    for (const [err, data] of results) {
      if (err || !data || typeof data !== 'object') continue;
      const record = data as Record<string, string>;
      if (!record.id) continue;

      const rule = this.hydrateRule(record);
      if (filter?.catId && rule.catId !== filter.catId && rule.catId !== '*') continue;
      if (filter?.threadId && rule.scope === 'thread' && rule.threadId !== filter.threadId) continue;
      rules.push(rule);
    }

    return rules.sort((a, b) => b.createdAt - a.createdAt);
  }

  private async evictIfFull(): Promise<void> {
    const count = await this.redis.zcard(AuthRuleKeys.ALL);
    if (count < this.maxRules) return;
    // FIFO: remove oldest (lowest score)
    const oldest = await this.redis.zrange(AuthRuleKeys.ALL, 0, 0);
    if (oldest.length > 0) {
      await this.redis.del(AuthRuleKeys.detail(oldest[0]!));
      await this.redis.zrem(AuthRuleKeys.ALL, oldest[0]!);
    }
  }

  private serializeRule(rule: AuthorizationRule): string[] {
    const fields: string[] = [
      'id',
      rule.id,
      'catId',
      rule.catId,
      'action',
      rule.action,
      'scope',
      rule.scope,
      'decision',
      rule.decision,
      'createdAt',
      String(rule.createdAt),
      'createdBy',
      rule.createdBy,
    ];
    if (rule.threadId) fields.push('threadId', rule.threadId);
    if (rule.reason) fields.push('reason', rule.reason);
    return fields;
  }

  private hydrateRule(data: Record<string, string>): AuthorizationRule {
    return {
      id: data.id!,
      catId: data.catId! as CatId | '*',
      action: data.action!,
      scope: data.scope! as 'thread' | 'global',
      decision: data.decision! as 'allow' | 'deny',
      createdAt: parseInt(data.createdAt!, 10),
      createdBy: data.createdBy!,
      ...(data.threadId ? { threadId: data.threadId } : {}),
      ...(data.reason ? { reason: data.reason } : {}),
    };
  }
}
