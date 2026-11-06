import type { TurnExecutionRecord } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  assertResponseSettlement,
  responseSettlementIdentity,
  type SettledTurnPage,
  type SettledTurnQuery,
  type SettleTurnResponseResult,
  settledTurnPageLimit,
  type TurnResponseSettlement,
} from '../ports/TurnExecutionSettlement.js';
import { TurnExecutionKeys } from '../redis-keys/turn-execution-keys.js';

const SETTLE_RESPONSE_LUA = `
local status = redis.call('HGET', KEYS[1], 'status')
if not status then return -1 end
local previous = redis.call('HGET', KEYS[1], 'responseSettlementIdentity')
if previous then
  if previous == ARGV[1] then return 2 end
  return 0
end
local pendingIdentity = redis.call('HGET', KEYS[1], 'pendingResponseSettlementIdentity')
if pendingIdentity and pendingIdentity ~= ARGV[1] then return 0 end
redis.call('HSETNX', KEYS[1], 'pendingResponseSettlement', ARGV[2])
redis.call('HSETNX', KEYS[1], 'pendingResponseSettlementIdentity', ARGV[1])
if status == 'running' then return -2 end
local ended = tonumber(redis.call('HGET', KEYS[1], 'endedAt'))
local at = tonumber(ARGV[3])
if not ended then return -2 end
local teardown = redis.call('HGET', KEYS[1], 'providerTeardownAt')
if status == 'succeeded' and redis.call('HGET', KEYS[1], 'providerLifecycleTracked') == '1'
  and redis.call('HEXISTS', KEYS[1], 'providerStartedAt') == 1
  and not teardown then return -2 end
at = math.max(at, ended, tonumber(teardown) or 0)
local settlement = cjson.decode(redis.call('HGET', KEYS[1], 'pendingResponseSettlement'))
settlement.settledAt = at
local sequence = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'responseSettlement', cjson.encode(settlement),
  'responseSettlementIdentity', ARGV[1], 'settledSequence', sequence)
redis.call('HDEL', KEYS[1], 'pendingResponseSettlement', 'pendingResponseSettlementIdentity')
redis.call('ZADD', KEYS[3], sequence, ARGV[4])
if redis.call('HGET', KEYS[1], 'executionKind') == 'watcher' then
  redis.call('ZADD', KEYS[6] .. math.floor(tonumber(redis.call('HGET', KEYS[1], 'startedAt')) / 86400000), sequence, ARGV[4])
  local attempts = cjson.decode(redis.call('HGET', KEYS[1], 'watcherModelAttempts') or '{}')
  for _, attempt in pairs(attempts) do
    redis.call('ZADD', KEYS[6] .. math.floor(attempt.startedAt / 86400000), sequence, ARGV[4])
  end
end
redis.call('ZADD', KEYS[4], sequence, ARGV[4])
redis.call('SREM', KEYS[5], ARGV[4])
return 1
`;

/** An index of the canonical child settlement; it owns no message body or work queue. */
export class RedisTurnExecutionSettlement {
  constructor(
    private readonly redis: RedisClient,
    private readonly getRecord: (invocationId: string) => Promise<TurnExecutionRecord | null>,
  ) {}

  async publishPending(invocationId: string): Promise<void> {
    const record = await this.getRecord(invocationId);
    if (record?.pendingResponseSettlement && record.status !== 'running')
      await this.mark(invocationId, record.pendingResponseSettlement);
  }

  async mark(invocationId: string, settlement: TurnResponseSettlement): Promise<SettleTurnResponseResult> {
    assertResponseSettlement(settlement);
    const before = await this.getRecord(invocationId);
    if (!before) return { outcome: 'not_found', record: null };
    const outcome = Number(
      await this.redis.eval(
        SETTLE_RESPONSE_LUA,
        6,
        TurnExecutionKeys.record(invocationId),
        TurnExecutionKeys.settledSequence,
        TurnExecutionKeys.settledUser(before.userId),
        TurnExecutionKeys.settledThread(before.userId, before.threadId),
        TurnExecutionKeys.responsePending,
        TurnExecutionKeys.watcherDayPrefix(before.userId),
        responseSettlementIdentity(settlement),
        JSON.stringify(settlement),
        String(settlement.settledAt),
        invocationId,
      ),
    );
    const record = await this.getRecord(invocationId);
    return {
      outcome:
        outcome === 1
          ? 'settled'
          : outcome === 2
            ? 'replayed'
            : outcome === -2
              ? 'not_ready'
              : outcome === -1
                ? 'not_found'
                : 'conflict',
      record,
    };
  }

  async list(query: SettledTurnQuery): Promise<SettledTurnPage> {
    const limit = settledTurnPageLimit(query);
    if (query.watcherDays) {
      const pages = await Promise.all(
        query.watcherDays.map((watcherDay) => this.list({ ...query, watcherDays: undefined, watcherDay })),
      );
      const candidates = [
        ...new Map(pages.flatMap((page) => page.records).map((record) => [record.invocationId, record])).values(),
      ].sort((a, b) => a.settledSequence! - b.settledSequence!);
      const records = candidates.slice(0, limit);
      return {
        records,
        nextCursor: records.at(-1)?.settledSequence ?? query.afterSequence ?? 0,
        hasMore: candidates.length > limit || pages.some((page) => page.hasMore),
      };
    }
    const key =
      query.watcherDay !== undefined
        ? `${TurnExecutionKeys.watcherDayPrefix(query.userId)}${query.watcherDay}`
        : query.threadId
          ? TurnExecutionKeys.settledThread(query.userId, query.threadId)
          : TurnExecutionKeys.settledUser(query.userId);
    const ids = await this.redis.zrangebyscore(key, `(${query.afterSequence ?? 0}`, '+inf', 'LIMIT', 0, limit + 1);
    const records = await Promise.all(
      ids.slice(0, limit).map(async (id) => {
        const record = await this.getRecord(id);
        if (
          !record?.responseSettlement ||
          record.userId !== query.userId ||
          (query.threadId !== undefined && record.threadId !== query.threadId) ||
          !record.settledSequence ||
          record.settledSequence <= (query.afterSequence ?? 0)
        )
          throw new Error(`corrupt settled turn index: ${id}`);
        return record;
      }),
    );
    return {
      records,
      nextCursor: records.at(-1)?.settledSequence ?? query.afterSequence ?? 0,
      hasMore: ids.length > limit,
    };
  }
}
