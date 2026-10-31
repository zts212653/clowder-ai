/**
 * BallCustodyEventLog — append-only Redis-backed event log（F233 Phase B）
 *
 * 1:1 照 CommunityEventLog（F168）：Lua MULTI-style 脚本在一次 round-trip 内检查
 * `seen` SET + append 到 log list，防并发重复 append。
 *
 * Canonical guarantee: TTL 永不设在事件 key（铁律#5 / LL-048）。
 */

import type { BallCustodyEvent } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { BallCustodyKeys } from './ball-custody-keys.js';

export interface IBallCustodyEventLog {
  /**
   * 幂等 append。若 `sourceEventId` 已存在 → `{ appended: false, sequence: -1 }`；
   * 否则 append 到 per-subject list，返回新长度对应的 0-based sequence。
   */
  append(event: BallCustodyEvent): Promise<{ appended: boolean; sequence: number }>;

  /**
   * Append only when the subject log is still at `expectedSequence` (the next
   * 0-based position). Duplicate detection wins over the sequence fence so an
   * exact retry stays idempotent after later events land.
   */
  appendFenced(event: BallCustodyEvent, expectedSequence: number): Promise<BallCustodyFencedAppendResult>;

  /** 按插入序读 subject 事件。fromSequence = 0-based 起点（默认 0 = 全部）。 */
  read(subjectKey: string, fromSequence?: number): Promise<BallCustodyEvent[]>;

  /** 列出所有至少有一条事件的 subjectKey。 */
  listSubjects(): Promise<string[]>;
}

export type BallCustodyFencedAppendResult =
  | { outcome: 'appended'; sequence: number }
  | { outcome: 'duplicate' }
  | { outcome: 'conflict'; actualSequence: number };

/**
 * KEYS[1] = ballcustody:events:log:{subjectKey}   (per-subject LIST)
 * KEYS[2] = ballcustody:events:seen               (global SET)
 * KEYS[3] = ballcustody:events:subjects           (global subjects SET)
 * ARGV[1] = sourceEventId  ARGV[2] = JSON 事件  ARGV[3] = subjectKey
 * Returns: 0（已 seen）或 RPUSH 后的 list 长度（>= 1）
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

const APPEND_FENCED_LUA = `
local already = redis.call('SISMEMBER', KEYS[2], ARGV[1])
if already == 1 then
  return {0, -1}
end

local current = redis.call('LLEN', KEYS[1])
if current ~= tonumber(ARGV[2]) then
  return {-1, current}
end

redis.call('SADD', KEYS[2], ARGV[1])
redis.call('SADD', KEYS[3], ARGV[4])
redis.call('RPUSH', KEYS[1], ARGV[3])
return {1, current}
`;

function requireSequence(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

export class RedisBallCustodyEventLog implements IBallCustodyEventLog {
  constructor(private readonly redis: RedisClient) {}

  async append(event: BallCustodyEvent): Promise<{ appended: boolean; sequence: number }> {
    const result = (await this.redis.eval(
      APPEND_LUA,
      3,
      BallCustodyKeys.eventLog(event.subjectKey),
      BallCustodyKeys.eventsSeen,
      BallCustodyKeys.eventsSubjects,
      event.sourceEventId,
      JSON.stringify(event),
      event.subjectKey,
    )) as number;

    if (result === 0) {
      return { appended: false, sequence: -1 };
    }
    return { appended: true, sequence: result - 1 };
  }

  async appendFenced(event: BallCustodyEvent, expectedSequence: number): Promise<BallCustodyFencedAppendResult> {
    requireSequence(expectedSequence, 'expectedSequence');
    const result = (await this.redis.eval(
      APPEND_FENCED_LUA,
      3,
      BallCustodyKeys.eventLog(event.subjectKey),
      BallCustodyKeys.eventsSeen,
      BallCustodyKeys.eventsSubjects,
      event.sourceEventId,
      expectedSequence.toString(),
      JSON.stringify(event),
      event.subjectKey,
    )) as [number, number];

    if (result[0] === 0) return { outcome: 'duplicate' };
    if (result[0] === -1) return { outcome: 'conflict', actualSequence: result[1] };
    return { outcome: 'appended', sequence: result[1] };
  }

  async read(subjectKey: string, fromSequence = 0): Promise<BallCustodyEvent[]> {
    const raw = await this.redis.lrange(BallCustodyKeys.eventLog(subjectKey), fromSequence, -1);
    return raw.map((s) => JSON.parse(s) as BallCustodyEvent);
  }

  async listSubjects(): Promise<string[]> {
    return this.redis.smembers(BallCustodyKeys.eventsSubjects);
  }
}
