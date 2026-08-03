import type { PawFeelDispositionEvent } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { parsePawFeelDispositionEvent } from './schema.js';

const KEYSPACE = 'paw-feel:disposition';

export const PawFeelDispositionKeys = {
  eventLog: (signalId: string): string => `${KEYSPACE}:log:${signalId}`,
  eventsSeen: `${KEYSPACE}:events:seen`,
  signals: `${KEYSPACE}:signals`,
} as const;

export type PawFeelDispositionAppendResult =
  | { outcome: 'appended'; sequence: number }
  | { outcome: 'duplicate' }
  | { outcome: 'conflict'; actualSequence: number };

export interface IPawFeelDispositionEventLog {
  append(event: PawFeelDispositionEvent, expectedSequence: number): Promise<PawFeelDispositionAppendResult>;
  read(signalId: string, fromSequence?: number): Promise<PawFeelDispositionEvent[]>;
  readMany?(signalIds: readonly string[]): Promise<Map<string, PawFeelDispositionEvent[]>>;
  listSignalIds(): Promise<string[]>;
}

const APPEND_LUA = `
local duplicate = redis.call('SISMEMBER', KEYS[2], ARGV[1])
if duplicate == 1 then
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

export class RedisPawFeelDispositionEventLog implements IPawFeelDispositionEventLog {
  constructor(private readonly redis: RedisClient) {}

  async append(event: PawFeelDispositionEvent, expectedSequence: number): Promise<PawFeelDispositionAppendResult> {
    requireSequence(expectedSequence, 'expectedSequence');
    const validated = parsePawFeelDispositionEvent(event);
    const result = (await this.redis.eval(
      APPEND_LUA,
      3,
      PawFeelDispositionKeys.eventLog(validated.signalId),
      PawFeelDispositionKeys.eventsSeen,
      PawFeelDispositionKeys.signals,
      validated.eventId,
      expectedSequence.toString(),
      JSON.stringify(validated),
      validated.signalId,
    )) as [number, number];

    if (result[0] === 0) return { outcome: 'duplicate' };
    if (result[0] === -1) return { outcome: 'conflict', actualSequence: result[1] };
    return { outcome: 'appended', sequence: result[1] };
  }

  async read(signalId: string, fromSequence = 0): Promise<PawFeelDispositionEvent[]> {
    requireSequence(fromSequence, 'fromSequence');
    const encoded = await this.redis.lrange(PawFeelDispositionKeys.eventLog(signalId), fromSequence, -1);
    return encoded.map((value) => parsePawFeelDispositionEvent(JSON.parse(value)));
  }

  async listSignalIds(): Promise<string[]> {
    return (await this.redis.smembers(PawFeelDispositionKeys.signals)).sort();
  }

  async readMany(signalIds: readonly string[]): Promise<Map<string, PawFeelDispositionEvent[]>> {
    const pipeline = this.redis.pipeline();
    for (const signalId of signalIds) pipeline.lrange(PawFeelDispositionKeys.eventLog(signalId), 0, -1);
    const replies = await pipeline.exec();
    if (!replies) throw new Error('paw-feel event-log pipeline returned no replies');
    const events = new Map<string, PawFeelDispositionEvent[]>();
    for (let index = 0; index < signalIds.length; index += 1) {
      const signalId = signalIds[index];
      const reply = replies[index];
      if (!signalId || !reply) throw new Error('paw-feel event-log pipeline response is incomplete');
      const [error, encoded] = reply;
      if (error) throw error;
      events.set(
        signalId,
        (encoded as string[]).map((value) => parsePawFeelDispositionEvent(JSON.parse(value))),
      );
    }
    return events;
  }
}
