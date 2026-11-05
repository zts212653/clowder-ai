/**
 * Plugin Messaging — Redis event log (K-1 / F288), split out of `redis.ts` unchanged.
 *
 * One Lua script does dedupe-check → INCR seq → ZADD → trim (INV-3). Events are stored WITHOUT
 * sequence; the ZSET score is the authoritative sequence, stamped on the read path. The same script
 * checks and writes the durable publication fence (W2-5b), which only its publisher releases.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { MessageOutputEvent } from '@clowder-ai/plugin-contract';
import type { MessageOutputEventInput } from '../contract/host-types.js';
import type { AppendLease, EventAppendOptions, EventLogAppendResult, EventLogStore } from './ports.js';
import { MessagingKeys } from './redis-keys.js';

const EVENT_APPEND_LUA = `
if ARGV[4] ~= '' and redis.call('GET', KEYS[4]) ~= ARGV[4] then
  return {'', 0, 1}
end
local existing = redis.call('HGET', KEYS[2], ARGV[1])
if existing then return {existing, 1, 0} end
if ARGV[5] == '1' then
  local fenced = redis.call('GET', KEYS[5])
  if fenced then return {fenced, 1, 0} end
end
local seq = redis.call('INCR', KEYS[3])
redis.call('ZADD', KEYS[1], seq, ARGV[1] .. '|' .. ARGV[2])
redis.call('HSET', KEYS[2], ARGV[1], seq)
local retention = tonumber(ARGV[3])
local count = redis.call('ZCARD', KEYS[1])
if count > retention then
  local removed = redis.call('ZRANGE', KEYS[1], 0, count - retention - 1)
  redis.call('ZREMRANGEBYRANK', KEYS[1], 0, count - retention - 1)
  for _, member in ipairs(removed) do
    local sep = string.find(member, '|', 1, true)
    if sep then redis.call('HDEL', KEYS[2], string.sub(member, 1, sep - 1)) end
  end
end
if ARGV[5] == '1' then redis.call('SET', KEYS[5], seq) end
return {tostring(seq), 0, 0}
`;

export class RedisEventLogStore implements EventLogStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async append(
    threadId: string,
    eventKey: string,
    event: MessageOutputEventInput,
    retentionCount: number,
    lease?: AppendLease,
    options?: EventAppendOptions,
  ): Promise<EventLogAppendResult> {
    const messageId = event.type === 'message.publish' ? event.envelope.messageId : event.messageId;
    if (lease !== undefined && lease.messageId !== messageId) {
      return { deduped: false, fencedOut: true };
    }
    // Encoded eventKey is the member prefix AND dedupe hash field — '|' inside
    // caller keys can never split the member incorrectly.
    const encodedKey = encodeURIComponent(eventKey);
    const result = (await this.redis.eval(
      EVENT_APPEND_LUA,
      5,
      MessagingKeys.events(threadId),
      MessagingKeys.eventDedupe(threadId),
      MessagingKeys.eventSeq(threadId),
      MessagingKeys.appendLock(lease?.messageId ?? '__unfenced__'),
      MessagingKeys.eventFence(threadId, encodedKey),
      encodedKey,
      JSON.stringify(event),
      String(retentionCount),
      lease?.token ?? '',
      options?.durableFence ? '1' : '',
    )) as [string, number, number];
    if (result[2] === 1) return { deduped: false, fencedOut: true };
    return { sequence: Number(result[0]), deduped: result[1] === 1, fencedOut: false };
  }

  async releaseFence(threadId: string, eventKey: string): Promise<void> {
    await this.redis.del(MessagingKeys.eventFence(threadId, encodeURIComponent(eventKey)));
  }

  private static parseMember(member: string, score: string): MessageOutputEvent {
    const sep = member.indexOf('|');
    const json = sep >= 0 ? member.slice(sep + 1) : member;
    const event = JSON.parse(json) as MessageOutputEventInput;
    return { ...event, sequence: Number(score) } as MessageOutputEvent;
  }

  async readAfter(threadId: string, afterSequence: number, limit: number): Promise<MessageOutputEvent[]> {
    const raw = (await this.redis.zrangebyscore(
      MessagingKeys.events(threadId),
      `(${afterSequence}`,
      '+inf',
      'WITHSCORES',
      'LIMIT',
      0,
      limit,
    )) as string[];
    const events: MessageOutputEvent[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const member = raw[i];
      const score = raw[i + 1];
      if (member !== undefined && score !== undefined) {
        events.push(RedisEventLogStore.parseMember(member, score));
      }
    }
    return events;
  }

  async minSequence(threadId: string): Promise<number | null> {
    const raw = (await this.redis.zrange(MessagingKeys.events(threadId), 0, 0, 'WITHSCORES')) as string[];
    const score = raw[1];
    return score !== undefined ? Number(score) : null;
  }

  async headSequence(threadId: string): Promise<number> {
    const raw = await this.redis.get(MessagingKeys.eventSeq(threadId));
    return raw ? Number(raw) : 0;
  }
}
