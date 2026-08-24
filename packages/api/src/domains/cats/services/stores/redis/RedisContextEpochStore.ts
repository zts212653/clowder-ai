/**
 * F296 B1/B2a: Redis-backed context epoch persistence.
 *
 * Iron Rule #5 (LL-048): recoverable state is persistent — TTL=0. An epoch that
 * resets on API restart would be worse than no epoch at all: the counter would be
 * reused, and a ledger keyed by (scope, epoch) would treat already-delivered
 * projections as fresh.
 *
 * B2a: the write is a Lua compare-and-set. Two writers exist on one scope — the
 * invocation path and the PreCompact hook route, which never takes the
 * invocation's process-local policy mutex — so a plain HSET would let both land
 * on the same epoch.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { ContextEpochRecord, IContextEpochStore } from '../ports/ContextEpochStore.js';
import { ContextEpochKeys } from '../redis-keys/context-epoch-keys.js';
import { PresentationLedgerKeys } from '../redis-keys/presentation-ledger-keys.js';

const DEFAULT_TTL = 0; // persistent

/**
 * Compare-and-set. Rewrites the whole hash so a cleared binding actually
 * disappears (a lingering binding would let a later `resumed` claim match a
 * runtime we deliberately let go of when we failed closed).
 *
 * KEYS[1] = scope hash
 * KEYS[2] = exact presentation generation that a sequential advance retires
 * ARGV[1] = expected version ("0" = expect absent)
 * ARGV[2] = JSON fields
 * ARGV[3] = ttl seconds (0 = persistent)
 */
const COMPARE_AND_SET_LUA = `
local current = redis.call('HGET', KEYS[1], 'version')
local expected = tonumber(ARGV[1])
local currentVersion = tonumber(current) or 0
if currentVersion ~= expected then
  return 0
end
local currentEpoch = tonumber(redis.call('HGET', KEYS[1], 'contextEpoch'))
local fields = cjson.decode(ARGV[2])
local nextEpoch = tonumber(fields.contextEpoch)
if currentEpoch and nextEpoch == currentEpoch + 1 then
  redis.call('DEL', KEYS[2])
end
redis.call('DEL', KEYS[1])
for field, value in pairs(fields) do
  redis.call('HSET', KEYS[1], field, value)
end
local ttl = tonumber(ARGV[3])
if ttl and ttl > 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
end
return 1
`;

export class RedisContextEpochStore implements IContextEpochStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly ttlSeconds: number = DEFAULT_TTL,
  ) {}

  async get(scopeKey: string): Promise<ContextEpochRecord | null> {
    const raw = await this.redis.hgetall(ContextEpochKeys.scope(scopeKey));
    if (!raw || Object.keys(raw).length === 0) return null;
    const contextEpoch = Number.parseInt(raw.contextEpoch ?? '', 10);
    if (!Number.isFinite(contextEpoch) || contextEpoch < 1) return null;
    let consumed: string[] = [];
    if (raw.consumedCompactionEventIds) {
      try {
        const parsed: unknown = JSON.parse(raw.consumedCompactionEventIds);
        if (Array.isArray(parsed)) consumed = parsed.filter((id): id is string => typeof id === 'string');
      } catch {
        // Corrupt payload degrades to "nothing consumed": the failure direction
        // is an extra cold rebuild, never a missed one.
      }
    }
    // F296 B4: a cold committed by observeCompaction must survive the round trip.
    // Dropping this field here would make every production read look like
    // "cold not yet consumed", which latches the scope permanently cold —
    // the in-memory store would never show it.
    const coldConsumedAtEpoch = Number.parseInt(raw.coldConsumedAtEpoch ?? '', 10);
    return {
      scopeKey,
      contextEpoch,
      contextMode: raw.contextMode === 'hot' ? 'hot' : 'cold',
      ...(raw.boundRuntimeSessionId ? { boundRuntimeSessionId: raw.boundRuntimeSessionId } : {}),
      lastTransitionRef: raw.lastTransitionRef ?? '',
      consumedCompactionEventIds: consumed,
      ...(Number.isFinite(coldConsumedAtEpoch) && coldConsumedAtEpoch >= 1 ? { coldConsumedAtEpoch } : {}),
      version: Number.parseInt(raw.version ?? '0', 10) || 0,
      updatedAt: Number.parseInt(raw.updatedAt ?? '0', 10) || 0,
    };
  }

  async compareAndPut(record: ContextEpochRecord, expectedVersion: number): Promise<boolean> {
    const fields: Record<string, string> = {
      contextEpoch: String(record.contextEpoch),
      contextMode: record.contextMode,
      lastTransitionRef: record.lastTransitionRef,
      consumedCompactionEventIds: JSON.stringify(record.consumedCompactionEventIds ?? []),
      version: String(record.version),
      updatedAt: String(record.updatedAt),
    };
    if (record.boundRuntimeSessionId) fields.boundRuntimeSessionId = record.boundRuntimeSessionId;
    if (record.coldConsumedAtEpoch !== undefined) {
      fields.coldConsumedAtEpoch = String(record.coldConsumedAtEpoch);
    }

    const result = await this.redis.eval(
      COMPARE_AND_SET_LUA,
      2,
      ContextEpochKeys.scope(record.scopeKey),
      PresentationLedgerKeys.generationForScope(record.scopeKey, record.contextEpoch - 1),
      String(expectedVersion),
      JSON.stringify(fields),
      String(this.ttlSeconds),
    );
    return Number(result) === 1;
  }
}
