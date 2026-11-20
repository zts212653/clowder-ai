import type { TurnExecutionRecord } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  type CacheExecutionObservation,
  type CacheExecutionScope,
  cacheExecutionScopeKey,
  type FirstCacheExecution,
  isCacheInput,
  type TurnExecutionCacheFacts,
} from '../ports/TurnExecutionCacheFacts.js';

const orderKey = (scope: CacheExecutionScope) => `turnexec:cache-order:${cacheExecutionScopeKey(scope)}`;
const entryKey = (id: string) => `turnexec:cache-entry:${id}`;
const observationKey = (id: string) => `turnexec:cache-observation:${id}`;
const OBSERVE = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local old = redis.call('GET', KEYS[2])
if old then if old == ARGV[1] then return 1 else return 0 end end
redis.call('SET', KEYS[2], ARGV[1])
return 1`;

/** Entry order and usage have no TTL, just like the canonical executions they reference. */
export class RedisTurnExecutionCacheFacts implements TurnExecutionCacheFacts {
  constructor(
    private readonly redis: RedisClient,
    private readonly get: (id: string) => Promise<TurnExecutionRecord | null>,
  ) {}
  entryKeys(record: TurnExecutionRecord): string[] {
    return isCacheInput(record) ? [orderKey(record), entryKey(record.invocationId)] : [];
  }
  async head(scope: CacheExecutionScope): Promise<number> {
    return Number((await this.redis.hget(orderKey(scope), 'head')) ?? 0);
  }
  async sequenceOf(scope: CacheExecutionScope, id: string): Promise<number | undefined> {
    const sequence = Number(await this.redis.get(entryKey(id)));
    if (!Number.isSafeInteger(sequence) || sequence < 1) return undefined;
    return (await this.redis.hget(orderKey(scope), String(sequence))) === id ? sequence : undefined;
  }
  async recordObservation(id: string, value: CacheExecutionObservation): Promise<boolean> {
    if (value.observation.invocationId !== id) return false;
    return (await this.redis.eval(OBSERVE, 2, entryKey(id), observationKey(id), JSON.stringify(value))) === 1;
  }
  async firstAfter(scope: CacheExecutionScope, frontier: number): Promise<FirstCacheExecution> {
    if (!Number.isSafeInteger(frontier) || frontier < 0) return { status: 'unknown' };
    const [head, id] = await this.redis.hmget(orderKey(scope), 'head', String(frontier + 1));
    if (!id) return { status: Number(head ?? 0) > frontier ? 'unknown' : 'none' };
    const [raw, record] = await Promise.all([this.redis.get(observationKey(id)), this.get(id)]);
    if (!record || cacheExecutionScopeKey(record) !== cacheExecutionScopeKey(scope))
      return { status: 'unknown', invocationId: id };
    if (raw) {
      const value = JSON.parse(raw) as CacheExecutionObservation;
      return value.observation.invocationId === id
        ? { status: 'observed', invocationId: id, value }
        : { status: 'unknown', invocationId: id };
    }
    return record.status === 'running' ? { status: 'pending' } : { status: 'unknown', invocationId: id };
  }
}
