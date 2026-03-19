/**
 * Redis-backed ConnectorThreadBindingStore.
 * Persists connector↔thread bindings so they survive service restarts.
 *
 * Data model:
 *   Hash  connector-binding:{connectorId}:{externalChatId}  → binding fields
 *   Set   connector-binding-rev:{threadId}                  → unprefixed hash keys for reverse lookup
 *
 * Note: Set members are stored as UNPREFIXED keys (e.g. "connector-binding:feishu:chat1")
 * because ioredis keyPrefix applies to KEYS[] in Lua but not to values/members.
 * When reading members back, ioredis will add the prefix when we pass them to hgetall.
 *
 * F088 Multi-Platform Chat Gateway
 */

import type { ConnectorThreadBinding } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { IConnectorThreadBindingStore } from './ConnectorThreadBindingStore.js';
import { ConnectorBindingKeys } from './connector-binding-keys.js';

/**
 * Lua script for atomic bind: reads old threadId, cleans up old reverse index,
 * writes new hash + adds to new reverse index — all in one atomic operation.
 *
 * KEYS[1] = binding hash key (ioredis-prefixed)
 * KEYS[2] = new reverse index key (ioredis-prefixed)
 * KEYS[3] = user index sorted set key (ioredis-prefixed)
 * ARGV[1] = unprefixed hash key (used as Set member value)
 * ARGV[2] = connectorId
 * ARGV[3] = externalChatId
 * ARGV[4] = threadId (new)
 * ARGV[5] = userId
 * ARGV[6] = createdAt
 *
 * The actual ioredis key prefix is derived by subtracting the known unprefixed
 * reverse key suffix from KEYS[2]. This avoids hardcoding the prefix.
 */
const BIND_LUA = `
local hashKey = KEYS[1]
local newRevKey = KEYS[2]
local newUserKey = KEYS[3]
local memberKey = ARGV[1]
local connectorId = ARGV[2]
local externalChatId = ARGV[3]
local threadId = ARGV[4]
local userId = ARGV[5]
local createdAt = ARGV[6]
local userKeyPrefix = ARGV[7]

-- Derive the full (ioredis-prefixed) reverse key prefix from KEYS[2].
-- KEYS[2] = "{ioredisPrefix}connector-binding-rev:{newThreadId}"
-- We strip the newThreadId suffix to get the prefix for constructing old rev keys.
local fullRevPrefix = string.sub(newRevKey, 1, #newRevKey - #threadId)

-- Read old binding fields before overwriting
local oldThreadId = redis.call('HGET', hashKey, 'threadId')
local oldUserId = redis.call('HGET', hashKey, 'userId')
local oldConnectorId = redis.call('HGET', hashKey, 'connectorId')

-- If old binding pointed to a different thread, remove from old reverse index
if oldThreadId and oldThreadId ~= threadId then
  local oldRevKey = fullRevPrefix .. oldThreadId
  redis.call('SREM', oldRevKey, memberKey)
end

-- If old binding belonged to a different user/connector, remove from old user index
-- Derive ioredis prefix from KEYS[3] by stripping the unprefixed new user key suffix
if oldUserId and oldConnectorId and (oldUserId ~= userId or oldConnectorId ~= connectorId) then
  local unprefixedNewUserKey = userKeyPrefix .. connectorId .. ":" .. userId
  local ioredisPrefix = string.sub(newUserKey, 1, #newUserKey - #unprefixedNewUserKey)
  local oldUserKey = ioredisPrefix .. userKeyPrefix .. oldConnectorId .. ":" .. oldUserId
  redis.call('ZREM', oldUserKey, memberKey)
end

-- Write the new binding
redis.call('HSET', hashKey,
  'connectorId', connectorId,
  'externalChatId', externalChatId,
  'threadId', threadId,
  'userId', userId,
  'createdAt', createdAt)

-- Add to new reverse index (unprefixed key as member)
redis.call('SADD', newRevKey, memberKey)

-- Add to user index (sorted set, score = createdAt)
redis.call('ZADD', newUserKey, createdAt, memberKey)

return 1
`;

export class RedisConnectorThreadBindingStore implements IConnectorThreadBindingStore {
  constructor(private readonly redis: RedisClient) {}

  async bind(
    connectorId: string,
    externalChatId: string,
    threadId: string,
    userId: string,
  ): Promise<ConnectorThreadBinding> {
    const key = ConnectorBindingKeys.detail(connectorId, externalChatId);
    const newRevKey = ConnectorBindingKeys.byThread(threadId);
    const userKey = ConnectorBindingKeys.byUser(connectorId, userId);
    const createdAt = Date.now();

    await this.redis.eval(
      BIND_LUA,
      3,
      key,
      newRevKey,
      userKey,
      key, // ARGV[1]: unprefixed hash key as Set member
      connectorId, // ARGV[2]
      externalChatId, // ARGV[3]
      threadId, // ARGV[4]
      userId, // ARGV[5]
      String(createdAt), // ARGV[6]
      'connector-binding-user:', // ARGV[7]: user key prefix for old user cleanup
    );

    return { connectorId, externalChatId, threadId, userId, createdAt };
  }

  async getByExternal(connectorId: string, externalChatId: string): Promise<ConnectorThreadBinding | null> {
    const data = await this.redis.hgetall(ConnectorBindingKeys.detail(connectorId, externalChatId));
    if (!data || !data.connectorId) return null;
    return this.hydrate(data);
  }

  async getByThread(threadId: string): Promise<ConnectorThreadBinding[]> {
    const revKey = ConnectorBindingKeys.byThread(threadId);
    const memberKeys = await this.redis.smembers(revKey);
    if (memberKeys.length === 0) return [];

    // Members are unprefixed keys — ioredis will add prefix when we call hgetall
    const pipeline = this.redis.multi();
    for (const mk of memberKeys) {
      pipeline.hgetall(mk);
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const bindings: ConnectorThreadBinding[] = [];
    const staleKeys: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const entry = results[i];
      if (!entry) continue;
      const [err, data] = entry;
      if (err || !data || typeof data !== 'object') continue;
      const d = data as Record<string, string>;
      const mk = memberKeys[i];
      if (!mk) continue;
      if (!d.connectorId) {
        // Hash was deleted but reverse index entry remains — stale
        staleKeys.push(mk);
        continue;
      }
      if (d.threadId !== threadId) {
        // Binding was rebound to a different thread — stale reverse entry
        staleKeys.push(mk);
        continue;
      }
      bindings.push(this.hydrate(d));
    }

    // Best-effort self-healing: remove stale reverse index entries
    if (staleKeys.length > 0) {
      this.redis.srem(revKey, ...staleKeys).catch(() => {});
    }

    return bindings;
  }

  async remove(connectorId: string, externalChatId: string): Promise<boolean> {
    const key = ConnectorBindingKeys.detail(connectorId, externalChatId);
    const data = await this.redis.hgetall(key);
    if (!data || !data.connectorId) return false;

    const pipeline = this.redis.multi();
    pipeline.del(key);
    if (data.threadId) {
      pipeline.srem(ConnectorBindingKeys.byThread(data.threadId), key);
    }
    if (data.connectorId && data.userId) {
      pipeline.zrem(ConnectorBindingKeys.byUser(data.connectorId, data.userId), key);
    }
    await pipeline.exec();
    return true;
  }

  async listByUser(connectorId: string, userId: string, limit?: number): Promise<ConnectorThreadBinding[]> {
    const userKey = ConnectorBindingKeys.byUser(connectorId, userId);
    const effectiveLimit = limit ?? 20;
    const memberKeys = await this.redis.zrevrange(userKey, 0, effectiveLimit - 1);
    if (memberKeys.length === 0) return [];

    const pipeline = this.redis.multi();
    for (const mk of memberKeys) {
      pipeline.hgetall(mk);
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const bindings: ConnectorThreadBinding[] = [];
    for (let i = 0; i < results.length; i++) {
      const entry = results[i];
      if (!entry) continue;
      const [err, data] = entry;
      if (err || !data || typeof data !== 'object') continue;
      const d = data as Record<string, string>;
      if (!d.connectorId) continue;
      bindings.push(this.hydrate(d));
    }
    return bindings;
  }

  async setHubThread(
    connectorId: string,
    externalChatId: string,
    hubThreadId: string,
  ): Promise<ConnectorThreadBinding | null> {
    const key = ConnectorBindingKeys.detail(connectorId, externalChatId);
    const data = await this.redis.hgetall(key);
    if (!data || !data.connectorId) return null;
    await this.redis.hset(key, 'hubThreadId', hubThreadId);
    data.hubThreadId = hubThreadId;
    return this.hydrate(data);
  }

  private hydrate(data: Record<string, string>): ConnectorThreadBinding {
    return {
      connectorId: data.connectorId!,
      externalChatId: data.externalChatId!,
      threadId: data.threadId!,
      userId: data.userId!,
      createdAt: parseInt(data.createdAt ?? '0', 10),
      ...(data.hubThreadId ? { hubThreadId: data.hubThreadId } : {}),
    };
  }
}
