import { assertRecoveryCurrent } from '../../infrastructure/recovery/recovery-deadline.js';
import { ballEventFingerprint } from './ball-event-fingerprint.js';
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
  appendExact?(event: BallCustodyEvent): Promise<{ appended: boolean; sequence: number; confirmed: boolean }>;
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
const EVENT_PREFLIGHT = `
for i, expected in ipairs({'list', 'set', 'set', 'hash'}) do
  local kind = redis.call('TYPE', KEYS[i]).ok
  if kind ~= 'none' and kind ~= expected then return redis.error_reply('invalid_ball_event_index') end
end`;
const APPEND_LUA = `${EVENT_PREFLIGHT}
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then
  local proof = redis.call('HGET', KEYS[4], 'eventProof:' .. ARGV[1])
  if not proof then return -2 end
  if proof ~= ARGV[4] then return -3 end
  return 0
end
local projectionIntent = redis.call('HGET', KEYS[4], 'projectionIntent:' .. ARGV[1])
if ARGV[5] == '1' and projectionIntent then
  local ok, intent = pcall(cjson.decode, projectionIntent)
  if not ok or intent.fingerprint ~= ARGV[4] then return redis.error_reply('projection_event_identity_conflict') end
end
local length = redis.call('RPUSH', KEYS[1], ARGV[2])
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('SADD', KEYS[3], ARGV[3])
redis.call('HSET', KEYS[4], 'eventProof:' .. ARGV[1], ARGV[4])
if ARGV[5] == '1' and projectionIntent then redis.call('HSET', KEYS[4], 'projectionNative:' .. ARGV[1], ARGV[4]) end
return length`;
const APPEND_FENCED_LUA = `${EVENT_PREFLIGHT}
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then return {0, -1} end
local current = redis.call('LLEN', KEYS[1])
if current ~= tonumber(ARGV[2]) then return {-1, current} end
redis.call('RPUSH', KEYS[1], ARGV[3])
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('SADD', KEYS[3], ARGV[4])
redis.call('HSET', KEYS[4], 'eventProof:' .. ARGV[1], ARGV[5])
return {1, current}`;

function requireSequence(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

export class RedisBallCustodyEventLog implements IBallCustodyEventLog {
  constructor(private readonly redis: RedisClient) {}

  private async appendNative(event: BallCustodyEvent, confirmedProjection = false): Promise<number> {
    assertRecoveryCurrent();
    return Number(
      await this.redis.eval(
        APPEND_LUA,
        4,
        BallCustodyKeys.eventLog(event.subjectKey),
        BallCustodyKeys.eventsSeen,
        BallCustodyKeys.eventsSubjects,
        `ballcustody:events:meta:${event.subjectKey}`,
        event.sourceEventId,
        JSON.stringify(event),
        event.subjectKey,
        ballEventFingerprint(event),
        confirmedProjection ? '1' : '0',
      ),
    );
  }
  async append(event: BallCustodyEvent): Promise<{ appended: boolean; sequence: number }> {
    const result = await this.appendNative(event);
    return result <= 0 ? { appended: false, sequence: -1 } : { appended: true, sequence: result - 1 };
  }
  async appendExact(event: BallCustodyEvent): Promise<{ appended: boolean; sequence: number; confirmed: boolean }> {
    const result = await this.appendNative(event, true);
    if (result === -3) throw new Error('ball_event_identity_conflict');
    return { appended: result > 0, sequence: result > 0 ? result - 1 : -1, confirmed: result >= 0 };
  }

  /** Explicit legacy evidence census; never called by periodic recovery. */
  async initializeExactIndex(subject: string): Promise<void> {
    const metadata = `ballcustody:events:meta:${subject}`;
    let from = Number((await this.redis.hget(metadata, 'eventProofCursor')) ?? '0');
    const length = await this.redis.llen(BallCustodyKeys.eventLog(subject));
    while (from < length) {
      const batch = (
        await this.redis.lrange(BallCustodyKeys.eventLog(subject), from, Math.min(length - 1, from + 99))
      ).map((raw) => JSON.parse(raw) as BallCustodyEvent);
      if (!batch.length) throw new Error('ball_event_census_incomplete');
      const fields = batch.flatMap((event) => {
        if (event.subjectKey !== subject) throw new Error('ball_event_subject_mismatch');
        return [`eventProof:${event.sourceEventId}`, ballEventFingerprint(event)];
      });
      from += batch.length;
      await this.redis.eval(
        `
for i=2,#ARGV,2 do
  local old = redis.call('HGET', KEYS[1], ARGV[i])
  if old and old ~= ARGV[i+1] then return redis.error_reply('ball_event_identity_conflict') end
end
for i=2,#ARGV,2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i+1]) end
if tonumber(ARGV[1]) > tonumber(redis.call('HGET', KEYS[1], 'eventProofCursor') or '0') then redis.call('HSET', KEYS[1], 'eventProofCursor', ARGV[1]) end
return 1`,
        1,
        metadata,
        from,
        ...fields,
      );
    }
  }

  async appendFenced(event: BallCustodyEvent, expectedSequence: number): Promise<BallCustodyFencedAppendResult> {
    requireSequence(expectedSequence, 'expectedSequence');
    const result = (await this.redis.eval(
      APPEND_FENCED_LUA,
      4,
      BallCustodyKeys.eventLog(event.subjectKey),
      BallCustodyKeys.eventsSeen,
      BallCustodyKeys.eventsSubjects,
      `ballcustody:events:meta:${event.subjectKey}`,
      event.sourceEventId,
      expectedSequence.toString(),
      JSON.stringify(event),
      event.subjectKey,
      ballEventFingerprint(event),
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
