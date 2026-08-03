import type { RedisClient } from '@cat-cafe/shared/utils';
import { type EvalLifecycleEvent, EvalLifecycleEventSchema } from './reeval-closure-schema.js';

const KEYSPACE = 'eval:verdict-lifecycle';

export const ReevalClosureKeys = {
  eventLog: (subjectId: string): string => `${KEYSPACE}:log:${subjectId}`,
  eventsSeen: `${KEYSPACE}:events:seen`,
  verdicts: `${KEYSPACE}:verdicts`,
} as const;

export type ReevalClosureAppendResult =
  | { outcome: 'appended'; sequence: number }
  | { outcome: 'duplicate' }
  | { outcome: 'conflict'; actualSequence: number };

export interface IReevalClosureEventLog {
  append(event: EvalLifecycleEvent, expectedSequence: number): Promise<ReevalClosureAppendResult>;
  read(subjectId: string, fromSequence?: number): Promise<EvalLifecycleEvent[]>;
  listVerdictIds(): Promise<string[]>;
  listSubjectIds(): Promise<string[]>;
}

function lifecycleSubjectId(event: EvalLifecycleEvent): string {
  return event.caseId ?? event.verdictId;
}

/**
 * KEYS: subject log, global seen set, verdict index.
 * ARGV: event id, expected LLEN, encoded event, verdict id.
 *
 * Duplicate detection intentionally precedes the sequence comparison so a
 * retry remains idempotent even after later lifecycle events have landed.
 */
const APPEND_LUA = `
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

export class RedisReevalClosureEventLog implements IReevalClosureEventLog {
  constructor(private readonly redis: RedisClient) {}

  async append(event: EvalLifecycleEvent, expectedSequence: number): Promise<ReevalClosureAppendResult> {
    requireSequence(expectedSequence, 'expectedSequence');
    const validated = EvalLifecycleEventSchema.parse(event);
    const subjectId = lifecycleSubjectId(validated);
    const result = (await this.redis.eval(
      APPEND_LUA,
      3,
      ReevalClosureKeys.eventLog(subjectId),
      ReevalClosureKeys.eventsSeen,
      ReevalClosureKeys.verdicts,
      validated.eventId,
      expectedSequence.toString(),
      JSON.stringify(validated),
      subjectId,
    )) as [number, number];

    if (result[0] === 0) return { outcome: 'duplicate' };
    if (result[0] === -1) return { outcome: 'conflict', actualSequence: result[1] };
    return { outcome: 'appended', sequence: result[1] };
  }

  async read(subjectId: string, fromSequence = 0): Promise<EvalLifecycleEvent[]> {
    requireSequence(fromSequence, 'fromSequence');
    const raw = await this.redis.lrange(ReevalClosureKeys.eventLog(subjectId), fromSequence, -1);
    return raw.map((encoded) => EvalLifecycleEventSchema.parse(JSON.parse(encoded)));
  }

  async listVerdictIds(): Promise<string[]> {
    return (await this.redis.smembers(ReevalClosureKeys.verdicts)).sort();
  }

  async listSubjectIds(): Promise<string[]> {
    return this.listVerdictIds();
  }
}
