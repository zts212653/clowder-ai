import type { WaitTerminationEventV1 } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

export interface IWaitLifecycleEventLog {
  append(event: WaitTerminationEventV1): Promise<{ appended: boolean; sequence: number; confirmed?: true }>;
  read(waitId: string, fromSequence?: number): Promise<WaitTerminationEventV1[]>;
}

function eventJson(event: WaitTerminationEventV1): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(event)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [
          key,
          key === 'actor'
            ? Object.fromEntries(Object.entries(event.actor).sort(([a], [b]) => a.localeCompare(b)))
            : value,
        ]),
    ),
  );
}

export class MemoryWaitLifecycleEventLog implements IWaitLifecycleEventLog {
  private readonly events = new Map<string, WaitTerminationEventV1[]>();
  private readonly seen = new Map<string, string>();
  async append(event: WaitTerminationEventV1): Promise<{ appended: boolean; sequence: number; confirmed: true }> {
    const json = eventJson(event),
      previous = this.seen.get(event.eventId);
    if (previous !== undefined) {
      if (previous !== json) throw new Error('wait_event_identity_conflict');
      return { appended: false, sequence: -1, confirmed: true };
    }
    this.seen.set(event.eventId, json);
    const entries = this.events.get(event.waitId) ?? [];
    entries.push(structuredClone(event));
    this.events.set(event.waitId, entries);
    return { appended: true, sequence: entries.length - 1, confirmed: true };
  }
  async read(waitId: string, fromSequence = 0): Promise<WaitTerminationEventV1[]> {
    return structuredClone((this.events.get(waitId) ?? []).slice(fromSequence));
  }
}

const PREFLIGHT = `
for i, expected in ipairs({'list', 'set', 'hash', 'string'}) do
  local kind = redis.call('TYPE', KEYS[i]).ok
  if kind ~= 'none' and kind ~= expected then return redis.error_reply('invalid_wait_event_index') end
end
`;
const APPEND_LUA = `${PREFLIGHT}
local exact = redis.call('HGET', KEYS[3], ARGV[1])
if exact then
  if exact ~= ARGV[2] then return redis.error_reply('wait_event_identity_conflict') end
  return 0
end
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then
  return redis.error_reply('wait_event_exact_confirmation_unavailable')
end
if tonumber(redis.call('GET', KEYS[4]) or '0') ~= redis.call('LLEN', KEYS[1]) then
  return redis.error_reply('wait_event_exact_confirmation_unavailable')
end
redis.call('HSET', KEYS[3], ARGV[1], ARGV[2])
redis.call('SADD', KEYS[2], ARGV[1])
local length = redis.call('RPUSH', KEYS[1], ARGV[2])
redis.call('SET', KEYS[4], length)
return length
`;
const IMPORT_EXACT = `${PREFLIGHT}
for i=2,#ARGV,2 do
  local previous = redis.call('HGET', KEYS[3], ARGV[i])
  if previous and previous ~= ARGV[i+1] then return redis.error_reply('wait_event_identity_conflict') end
end
for i=2,#ARGV,2 do redis.call('HSET', KEYS[3], ARGV[i], ARGV[i+1]) end
if tonumber(ARGV[1]) > tonumber(redis.call('GET', KEYS[4]) or '0') then redis.call('SET', KEYS[4], ARGV[1]) end
return 1`;
function eventKeys(waitId: string): [string, string, string, string] {
  return [
    `wait-lifecycle:events:${waitId}`,
    'wait-lifecycle:events:seen',
    `wait-lifecycle:exact:${waitId}`,
    `wait-lifecycle:exact-cursor:${waitId}`,
  ];
}

export class RedisWaitLifecycleEventLog implements IWaitLifecycleEventLog {
  constructor(private readonly redis: RedisClient) {}

  /** Original event owner rebuilds its exact-event index once; later legacy writes import only their new tail. */
  async initializeExactIndex(waitId: string): Promise<void> {
    const keys = eventKeys(waitId);
    let from = Number((await this.redis.get(keys[3])) ?? '0');
    const length = await this.redis.llen(keys[0]);
    while (from < length) {
      const entries = await this.redis.lrange(keys[0], from, Math.min(length - 1, from + 99));
      if (!entries.length) throw new Error('wait_event_index_incomplete');
      const fields = entries.flatMap((raw) => {
        const event = JSON.parse(raw) as WaitTerminationEventV1;
        if (event.waitId !== waitId || !event.eventId) throw new Error('invalid_wait_event_identity');
        return [event.eventId, eventJson(event)];
      });
      from += entries.length;
      await this.redis.eval(IMPORT_EXACT, 4, ...keys, from, ...fields);
    }
  }

  async append(event: WaitTerminationEventV1): Promise<{ appended: boolean; sequence: number; confirmed: true }> {
    await this.initializeExactIndex(event.waitId);
    const result = Number(
      await this.redis.eval(APPEND_LUA, 4, ...eventKeys(event.waitId), event.eventId, eventJson(event)),
    );
    return result === 0
      ? { appended: false, sequence: -1, confirmed: true }
      : { appended: true, sequence: result - 1, confirmed: true };
  }
  async read(waitId: string, fromSequence = 0): Promise<WaitTerminationEventV1[]> {
    return (await this.redis.lrange(eventKeys(waitId)[0], fromSequence, -1)).map(
      (entry) => JSON.parse(entry) as WaitTerminationEventV1,
    );
  }
}
