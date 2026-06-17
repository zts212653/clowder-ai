/**
 * CommunityEventLog — append-only Redis-backed event log (F168 Phase A)
 *
 * Redis layout (bare keys; ioredis keyPrefix applied by client factory):
 *   community:events:log:{subjectKey}  → LIST of JSON-encoded CommunityEvent
 *   community:events:seen              → SET of sourceEventId (global dedup)
 *   community:events:subjects          → SET of subjectKey values
 *
 * Append atomicity: Lua MULTI-style script checks the `seen` SET and appends
 * to the log list in one round-trip, preventing duplicate appends under
 * concurrent writers.
 *
 * Canonical guarantee: TTL is never set on event keys (铁律 #5 / LL-048).
 *
 * NOTE on ioredis keyPrefix:
 *   Normal ioredis commands receive the keyPrefix automatically.
 *   Keys referenced inside Lua KEYS[] are also prefixed by ioredis.
 *   Dynamic keys built in Lua (ARGV-derived) must carry the prefix explicitly.
 *   See RedisRuntimeSessionStore for the established pattern.
 */

import type { CommunityEvent } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { CommunityKeys } from './community-keys.js';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ICommunityEventLog {
  /**
   * Idempotent append.
   * If `sourceEventId` already exists → `{ appended: false, sequence: -1 }`.
   * Otherwise appends to the per-subject list and returns the new length as `sequence`.
   */
  append(event: CommunityEvent): Promise<{ appended: boolean; sequence: number }>;

  /**
   * Read events for a subject in insertion order.
   * @param subjectKey  Stable subject identifier.
   * @param fromSequence  0-based index to start from (default 0 = all).
   */
  read(subjectKey: string, fromSequence?: number): Promise<CommunityEvent[]>;

  /** Return all subjectKeys that have at least one event. */
  listSubjects(): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Lua script: atomic idempotent append
// ---------------------------------------------------------------------------

/**
 * KEYS[1] = community:events:log:{subjectKey}   (per-subject LIST)
 * KEYS[2] = community:events:seen               (global SET)
 * KEYS[3] = community:events:subjects           (global subjects SET)
 *
 * ARGV[1] = sourceEventId
 * ARGV[2] = JSON-encoded CommunityEvent
 * ARGV[3] = subjectKey
 *
 * Returns: 0 (already seen) or list length after push (>= 1)
 */
const APPEND_LUA = `
local already = redis.call('SISMEMBER', KEYS[2], ARGV[1])
if already == 1 then
  return 0
end
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('SADD', KEYS[3], ARGV[3])
return redis.call('RPUSH', KEYS[1], ARGV[2])
`;

// ---------------------------------------------------------------------------
// Redis implementation
// ---------------------------------------------------------------------------

export class RedisCommunityEventLog implements ICommunityEventLog {
  constructor(private readonly redis: RedisClient) {}

  async append(event: CommunityEvent): Promise<{ appended: boolean; sequence: number }> {
    const logKey = CommunityKeys.eventLog(event.subjectKey);
    const seenKey = CommunityKeys.eventsSeen;
    const subjectsKey = CommunityKeys.eventsSubjects;

    const result = (await this.redis.eval(
      APPEND_LUA,
      3,
      logKey,
      seenKey,
      subjectsKey,
      event.sourceEventId,
      JSON.stringify(event),
      event.subjectKey,
    )) as number;

    if (result === 0) {
      return { appended: false, sequence: -1 };
    }
    return { appended: true, sequence: result - 1 };
  }

  async read(subjectKey: string, fromSequence = 0): Promise<CommunityEvent[]> {
    const logKey = CommunityKeys.eventLog(subjectKey);
    const raw = await this.redis.lrange(logKey, fromSequence, -1);
    return raw.map((s) => JSON.parse(s) as CommunityEvent);
  }

  async listSubjects(): Promise<string[]> {
    return this.redis.smembers(CommunityKeys.eventsSubjects);
  }
}
