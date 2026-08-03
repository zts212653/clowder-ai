/**
 * Plugin Messaging — Redis store implementations (K-1 / F258)
 *
 * Atomicity strategy:
 * - Ledger claim/settle/release: single Lua scripts (state machine §4a).
 * - Event append: one Lua script does dedupe-check → INCR seq → ZADD → trim
 *   (INV-3). Events are stored WITHOUT sequence; the ZSET score is the
 *   authoritative sequence, stamped on the read path — no JSON mutation in Lua.
 * - Cursor advances: Lua max-advance on a hash field (monotonic).
 * - Append lock: SET NX PX + del-if-token-matches release.
 * - Handle revoke / subscription revoke: JS read-modify-write — control-plane
 *   frequency, idempotent, first-revocation timestamp sticks.
 */

import { randomUUID } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { MessageOutputEvent } from '@clowder-ai/plugin-contract';
import type { MessageOutputEventInput } from '../contract/host-types.js';
import type {
  AppendLease,
  EventLogAppendResult,
  EventLogStore,
  HandleRecord,
  HandleStore,
  LedgerClaimResult,
  LedgerStore,
} from './ports.js';
import { MessagingKeys } from './redis-keys.js';

// ── Ledger ──

const LEDGER_CLAIM_LUA = `
local v = redis.call('GET', KEYS[1])
if v then return v end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return false
`;

const LEDGER_SETTLE_LUA = `
local v = redis.call('GET', KEYS[1])
if not v then return -1 end
local decoded = cjson.decode(v)
if decoded.status == 'settled' then return 0 end
if decoded.status ~= 'inflight' or decoded.claimToken ~= ARGV[1] then return -1 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`;

const LEDGER_RELEASE_LUA = `
local v = redis.call('GET', KEYS[1])
if v then
  local decoded = cjson.decode(v)
  if decoded.status == 'inflight' and decoded.claimToken == ARGV[1] then redis.call('DEL', KEYS[1]) end
end
return 0
`;

export class RedisLedgerStore implements LedgerStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async claim(key: string, claimTtlMs: number): Promise<LedgerClaimResult> {
    const claimToken = randomUUID();
    const existing = (await this.redis.eval(
      LEDGER_CLAIM_LUA,
      1,
      MessagingKeys.ledger(key),
      JSON.stringify({ status: 'inflight', claimToken }),
      String(claimTtlMs),
    )) as string | null;
    if (existing === null || existing === undefined) return { status: 'new', claimToken };
    const parsed = JSON.parse(existing) as { status: string; receipt?: unknown };
    if (parsed.status === 'settled') return { status: 'settled', receipt: parsed.receipt };
    return { status: 'inflight' };
  }

  async settle(key: string, claimToken: string, receipt: unknown, retentionMs: number): Promise<void> {
    await this.redis.eval(
      LEDGER_SETTLE_LUA,
      1,
      MessagingKeys.ledger(key),
      claimToken,
      JSON.stringify({ status: 'settled', receipt }),
      String(retentionMs),
    );
  }

  async release(key: string, claimToken: string): Promise<void> {
    await this.redis.eval(LEDGER_RELEASE_LUA, 1, MessagingKeys.ledger(key), claimToken);
  }
}

// ── Handles ──

export class RedisHandleStore implements HandleStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async put(record: HandleRecord): Promise<void> {
    await this.redis.set(MessagingKeys.handle(record.handleId), JSON.stringify(record));
  }

  async get(handleId: string): Promise<HandleRecord | null> {
    const raw = await this.redis.get(MessagingKeys.handle(handleId));
    return raw ? (JSON.parse(raw) as HandleRecord) : null;
  }

  async revoke(handleId: string, revokedAt: number): Promise<boolean> {
    const record = await this.get(handleId);
    if (!record) return false;
    if (record.revokedAt === undefined) {
      await this.put({ ...record, revokedAt });
    }
    return true;
  }
}

// ── Event log ──

const EVENT_APPEND_LUA = `
if ARGV[4] ~= '' and redis.call('GET', KEYS[4]) ~= ARGV[4] then
  return {'', 0, 1}
end
local existing = redis.call('HGET', KEYS[2], ARGV[1])
if existing then return {existing, 1, 0} end
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
      4,
      MessagingKeys.events(threadId),
      MessagingKeys.eventDedupe(threadId),
      MessagingKeys.eventSeq(threadId),
      MessagingKeys.appendLock(lease?.messageId ?? '__unfenced__'),
      encodedKey,
      JSON.stringify(event),
      String(retentionCount),
      lease?.token ?? '',
    )) as [string, number, number];
    if (result[2] === 1) return { deduped: false, fencedOut: true };
    return { sequence: Number(result[0]), deduped: result[1] === 1, fencedOut: false };
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

export { RedisAppendLock } from './redis-append-lock.js';
export { RedisCursorStore } from './redis-cursor.js';
