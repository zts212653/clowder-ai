/**
 * F296 B3a gate 4: Redis-backed, shared, persistent presentation ledger.
 *
 * AC-B6 promises "same subject + revision + epoch is not repeated". A
 * process-local Map cannot keep that promise: a second API instance has never
 * heard of the first instance's deliveries, and a restart forgets its own. Left
 * in memory, AC-B6 would be a statement about one process wearing the clothes of
 * a global guarantee — so either the store becomes shared or the AC has to be
 * narrowed. This buys the capability.
 *
 * Iron Rule #5 (LL-048): delivered records are recoverable state → TTL=0. The
 * reservation's expiry is therefore a FIELD evaluated inside Lua, never a Redis
 * TTL — a key TTL would quietly delete delivery history too.
 *
 * Every mutation is a single Lua script because the honesty of the state machine
 * is exactly its atomicity: a read-then-write pair here would restore the
 * double-injection race that B3a exists to close.
 *
 * B4a closes the superseded-generation gap without a scanner or reaper. Every
 * reserve/commit is fenced by the authoritative context epoch, while the epoch
 * CAS deletes exactly the generation it supersedes in the same Redis Lua
 * operation. Whichever script wins the Redis serialization order leaves the old
 * generation absent and unable to be recreated.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  CommitInput,
  CommitResult,
  IPresentationLedgerStore,
  PresentationLedgerAddress,
  ReserveInput,
  ReserveResult,
} from '../ports/PresentationLedgerStore.js';
import { ContextEpochKeys } from '../redis-keys/context-epoch-keys.js';
import { PresentationLedgerKeys } from '../redis-keys/presentation-ledger-keys.js';

/**
 * Take the entry unless it is delivered, or reserved by a still-live prompt.
 *
 * An expired reservation counts as free: the holder is presumed dead, and
 * wedging the projection forever would suppress content the cat never saw.
 *
 * KEYS[1] = generation hash   KEYS[2] = authoritative context epoch hash
 * ARGV[1] = field             ARGV[2] = token        ARGV[3] = nowMs
 * ARGV[4] = expiresAtMs       ARGV[5] = promptGenerationId
 * ARGV[6] = writeEpoch
 */
const RESERVE_LUA = `
local currentEpoch = tonumber(redis.call('HGET', KEYS[2], 'contextEpoch'))
if not currentEpoch or currentEpoch ~= tonumber(ARGV[6]) then
  return 'context_epoch_retired'
end
local current = redis.call('HGET', KEYS[1], ARGV[1])
if current then
  local entry = cjson.decode(current)
  if entry.state == 'delivered' then
    return 'already_delivered_this_epoch'
  end
  if entry.state == 'pending' and tonumber(entry.expiresAtMs) > tonumber(ARGV[3]) then
    return 'reserved_by_concurrent_prompt'
  end
end
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode({
  state = 'pending',
  token = ARGV[2],
  expiresAtMs = tonumber(ARGV[4]),
  promptGenerationId = ARGV[5]
}))
return 'reserved'
`;

/**
 * Turn our own live reservation into a delivery.
 *
 * Idempotent for the same token (at-least-once transports retry). Any other
 * token means we were superseded, and overwriting the current holder would
 * consume dedupe on someone else's behalf. A lapsed expiry is not itself a
 * rejection: if nobody reclaimed the entry it is still ours and the provider did
 * receive it — see the port for why refusing that would discard a true fact.
 *
 * KEYS[1] = generation hash   KEYS[2] = authoritative context epoch hash
 * ARGV[1] = field             ARGV[2] = token
 * ARGV[3] = deliveredAtMs     ARGV[4] = promptGenerationId
 * ARGV[5] = providerAdapterId ARGV[6] = writeEpoch
 */
const COMMIT_LUA = `
local currentEpoch = tonumber(redis.call('HGET', KEYS[2], 'contextEpoch'))
if not currentEpoch or currentEpoch ~= tonumber(ARGV[6]) then
  return 'context_epoch_retired'
end
local current = redis.call('HGET', KEYS[1], ARGV[1])
if not current then
  return 'reservation_superseded'
end
local entry = cjson.decode(current)
if entry.token ~= ARGV[2] then
  return 'reservation_superseded'
end
if entry.state == 'delivered' then
  return 'committed'
end
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode({
  state = 'delivered',
  token = ARGV[2],
  deliveredAtMs = tonumber(ARGV[3]),
  promptGenerationId = ARGV[4],
  providerAdapterId = ARGV[5]
}))
return 'committed'
`;

/**
 * Drop our own pending reservation. A stale token is a no-op — a dead prompt
 * must not release the reservation of the live one that replaced it.
 *
 * KEYS[1] = generation hash   ARGV[1] = field   ARGV[2] = token
 */
const RELEASE_LUA = `
local current = redis.call('HGET', KEYS[1], ARGV[1])
if not current then
  return 0
end
local entry = cjson.decode(current)
if entry.state == 'pending' and entry.token == ARGV[2] then
  redis.call('HDEL', KEYS[1], ARGV[1])
  return 1
end
return 0
`;

const RESERVE_RESULTS: ReadonlySet<string> = new Set<ReserveResult>([
  'reserved',
  'already_delivered_this_epoch',
  'reserved_by_concurrent_prompt',
  'context_epoch_retired',
]);

const COMMIT_RESULTS: ReadonlySet<string> = new Set<CommitResult>([
  'committed',
  'reservation_superseded',
  'context_epoch_retired',
]);

export class RedisPresentationLedgerStore implements IPresentationLedgerStore {
  constructor(private readonly redis: RedisClient) {}

  async reserve(address: PresentationLedgerAddress, input: ReserveInput): Promise<ReserveResult> {
    const raw = await this.redis.eval(
      RESERVE_LUA,
      2,
      PresentationLedgerKeys.generation(address.scopeKey),
      ContextEpochKeys.scope(address.contextScopeKey),
      address.entryField,
      input.token,
      String(input.nowMs),
      String(input.expiresAtMs),
      input.promptGenerationId,
      String(address.writeEpoch),
    );
    const result = String(raw);
    if (!RESERVE_RESULTS.has(result)) {
      throw new Error(`presentation_ledger_reserve_unexpected_result:${result}`);
    }
    return result as ReserveResult;
  }

  async commit(address: PresentationLedgerAddress, input: CommitInput): Promise<CommitResult> {
    const raw = await this.redis.eval(
      COMMIT_LUA,
      2,
      PresentationLedgerKeys.generation(address.scopeKey),
      ContextEpochKeys.scope(address.contextScopeKey),
      address.entryField,
      input.token,
      String(input.deliveredAtMs),
      input.promptGenerationId,
      input.providerAdapterId,
      String(address.writeEpoch),
    );
    const result = String(raw);
    if (!COMMIT_RESULTS.has(result)) {
      throw new Error(`presentation_ledger_commit_unexpected_result:${result}`);
    }
    return result as CommitResult;
  }

  async release(address: PresentationLedgerAddress, token: string): Promise<boolean> {
    const raw = await this.redis.eval(
      RELEASE_LUA,
      1,
      PresentationLedgerKeys.generation(address.scopeKey),
      address.entryField,
      token,
    );
    return Number(raw) === 1;
  }
}
