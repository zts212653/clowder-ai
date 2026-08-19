import type { WaitTerminationEventV1 } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

export interface IWaitLifecycleEventLog {
  append(event: WaitTerminationEventV1): Promise<{ appended: boolean; sequence: number }>;
  read(waitId: string, fromSequence?: number): Promise<WaitTerminationEventV1[]>;
}

export class MemoryWaitLifecycleEventLog implements IWaitLifecycleEventLog {
  private readonly events = new Map<string, WaitTerminationEventV1[]>();
  private readonly seen = new Set<string>();

  async append(event: WaitTerminationEventV1): Promise<{ appended: boolean; sequence: number }> {
    if (this.seen.has(event.eventId)) return { appended: false, sequence: -1 };
    this.seen.add(event.eventId);
    const entries = this.events.get(event.waitId) ?? [];
    entries.push(event);
    this.events.set(event.waitId, entries);
    return { appended: true, sequence: entries.length - 1 };
  }

  async read(waitId: string, fromSequence = 0): Promise<WaitTerminationEventV1[]> {
    return [...(this.events.get(waitId) ?? []).slice(fromSequence)];
  }
}

const APPEND_LUA = `
local already = redis.call('SISMEMBER', KEYS[2], ARGV[1])
if already == 1 then
  return 0
end
redis.call('SADD', KEYS[2], ARGV[1])
return redis.call('RPUSH', KEYS[1], ARGV[2])
`;

function waitEventLogKey(taskId: string): string {
  return `wait-lifecycle:events:${taskId}`;
}

export class RedisWaitLifecycleEventLog implements IWaitLifecycleEventLog {
  constructor(private readonly redis: RedisClient) {}

  async append(event: WaitTerminationEventV1): Promise<{ appended: boolean; sequence: number }> {
    const result = (await this.redis.eval(
      APPEND_LUA,
      2,
      waitEventLogKey(event.waitId),
      'wait-lifecycle:events:seen',
      event.eventId,
      JSON.stringify(event),
    )) as number;
    return result === 0 ? { appended: false, sequence: -1 } : { appended: true, sequence: result - 1 };
  }

  async read(waitId: string, fromSequence = 0): Promise<WaitTerminationEventV1[]> {
    const raw = await this.redis.lrange(waitEventLogKey(waitId), fromSequence, -1);
    return raw.map((entry) => JSON.parse(entry) as WaitTerminationEventV1);
  }
}
