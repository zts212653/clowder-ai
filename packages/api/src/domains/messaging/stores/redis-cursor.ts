/** Redis durable subscription records and monotonic delivery cursors. */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { CursorStore, SubscriptionRecord } from './ports.js';
import { MessagingKeys } from './redis-keys.js';

const CURSOR_ADVANCE_LUA = `
local cur = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '-1')
local nxt = tonumber(ARGV[2])
if nxt > cur then redis.call('HSET', KEYS[1], ARGV[1], nxt) end
return 0
`;

const SUBSCRIPTION_CREATE_OR_GET_LUA = `
local existing = redis.call('GET', KEYS[2])
if existing then return existing end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
redis.call('SADD', KEYS[3], ARGV[3])
redis.call('HSET', KEYS[4], 'acked', ARGV[4], 'delivered', ARGV[5])
return ARGV[2]
`;

export class RedisCursorStore implements CursorStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async put(record: SubscriptionRecord): Promise<void> {
    const { pluginInstanceId, subscriptionId, handleId } = record;
    await this.redis
      .multi()
      .set(MessagingKeys.subscription(pluginInstanceId, subscriptionId), JSON.stringify(record))
      .set(MessagingKeys.subscriptionByHandle(pluginInstanceId, handleId), subscriptionId)
      .sadd(
        MessagingKeys.subscriptionsOfHandle(handleId),
        `${encodeURIComponent(pluginInstanceId)}|${encodeURIComponent(subscriptionId)}`,
      )
      .hset(MessagingKeys.subscriptionCursor(pluginInstanceId, subscriptionId), {
        acked: String(record.ackedSequence),
        delivered: String(record.lastDeliveredSequence),
      })
      .exec();
  }

  async createOrGet(record: SubscriptionRecord): Promise<SubscriptionRecord> {
    const { pluginInstanceId, subscriptionId, handleId } = record;
    const winner = (await this.redis.eval(
      SUBSCRIPTION_CREATE_OR_GET_LUA,
      4,
      MessagingKeys.subscription(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionByHandle(pluginInstanceId, handleId),
      MessagingKeys.subscriptionsOfHandle(handleId),
      MessagingKeys.subscriptionCursor(pluginInstanceId, subscriptionId),
      JSON.stringify(record),
      subscriptionId,
      `${encodeURIComponent(pluginInstanceId)}|${encodeURIComponent(subscriptionId)}`,
      String(record.ackedSequence),
      String(record.lastDeliveredSequence),
    )) as string;
    const loaded = await this.get(pluginInstanceId, winner);
    if (!loaded) throw new Error(`subscription index points to missing record ${winner}`);
    return loaded;
  }

  async get(pluginInstanceId: string, subscriptionId: string): Promise<SubscriptionRecord | null> {
    const results = await this.redis
      .multi()
      .get(MessagingKeys.subscription(pluginInstanceId, subscriptionId))
      .hgetall(MessagingKeys.subscriptionCursor(pluginInstanceId, subscriptionId))
      .exec();
    const raw = results?.[0]?.[1];
    if (typeof raw !== 'string') return null;
    const record = JSON.parse(raw) as SubscriptionRecord;
    const cursorResult = results?.[1]?.[1];
    const cursors = cursorResult && typeof cursorResult === 'object' ? (cursorResult as Record<string, string>) : {};
    return {
      ...record,
      ackedSequence: cursors.acked !== undefined ? Number(cursors.acked) : record.ackedSequence,
      lastDeliveredSequence: cursors.delivered !== undefined ? Number(cursors.delivered) : record.lastDeliveredSequence,
    };
  }

  async findByHandle(pluginInstanceId: string, handleId: string): Promise<SubscriptionRecord | null> {
    const subscriptionId = await this.redis.get(MessagingKeys.subscriptionByHandle(pluginInstanceId, handleId));
    if (!subscriptionId) return null;
    const record = await this.get(pluginInstanceId, subscriptionId);
    return record && record.revokedAt === undefined ? record : null;
  }

  private async advance(
    pluginInstanceId: string,
    subscriptionId: string,
    field: 'acked' | 'delivered',
    sequence: number,
  ): Promise<void> {
    await this.redis.eval(
      CURSOR_ADVANCE_LUA,
      1,
      MessagingKeys.subscriptionCursor(pluginInstanceId, subscriptionId),
      field,
      String(sequence),
    );
  }

  async advanceAck(pluginInstanceId: string, subscriptionId: string, sequence: number): Promise<void> {
    await this.advance(pluginInstanceId, subscriptionId, 'acked', sequence);
  }

  async advanceDelivered(pluginInstanceId: string, subscriptionId: string, sequence: number): Promise<void> {
    await this.advance(pluginInstanceId, subscriptionId, 'delivered', sequence);
  }

  async revokeByHandle(handleId: string, revokedAt: number): Promise<number> {
    const members = await this.redis.smembers(MessagingKeys.subscriptionsOfHandle(handleId));
    let count = 0;
    for (const member of members) {
      const sep = member.indexOf('|');
      if (sep < 0) continue;
      const instanceId = decodeURIComponent(member.slice(0, sep));
      const subscriptionId = decodeURIComponent(member.slice(sep + 1));
      const record = await this.get(instanceId, subscriptionId);
      if (!record || record.revokedAt !== undefined) continue;
      await this.redis.set(
        MessagingKeys.subscription(instanceId, subscriptionId),
        JSON.stringify({ ...record, revokedAt }),
      );
      count += 1;
    }
    return count;
  }
}
