import type { RedisClient } from '@cat-cafe/shared/utils';
import type { InvocationRecord } from '../ports/InvocationRecordStore.js';
import { InvocationKeys as keys } from '../redis-keys/invocation-keys.js';
import { INVOCATION_OWNER_RECOVERY_LUA } from './invocation-owner-recovery-lua.js';
import { decodeInvocationHash } from './invocation-record-redis-codec.js';

const PROJECT = `${INVOCATION_OWNER_RECOVERY_LUA}
projectOwnerRecovery(KEYS[1], KEYS[2], ARGV[1], false)
return 1`;
const CLAIM = `${INVOCATION_OWNER_RECOVERY_LUA}
projectOwnerRecovery(KEYS[1], KEYS[2], ARGV[1], false)
local score = redis.call('ZSCORE', KEYS[2], ARGV[1])
if not score or tonumber(score) > tonumber(ARGV[2]) then return {} end
local facts = ownerFacts(KEYS[1])
facts.nextAt = tonumber(ARGV[3])
redis.call('HSET', KEYS[1], '_ownerRecovery', cjson.encode(facts))
redis.call('ZADD', KEYS[2], facts.nextAt, ARGV[1])
return redis.call('HGETALL', KEYS[1])`;
const PARK_INVALID = `${INVOCATION_OWNER_RECOVERY_LUA}
if redis.call('HGET', KEYS[1], 'status') ~= 'running' then return 0 end
local expected = cjson.decode(ARGV[2])
for key, value in pairs(expected) do if redis.call('HGET', KEYS[1], key) ~= value then return 0 end end
local facts = ownerFacts(KEYS[1])
facts.disposition = 'needs_attention'; facts.reasonCode = 'invalid_invocation_record'
redis.call('HSET', KEYS[1], '_ownerRecovery', cjson.encode(facts))
redis.call('ZREM', KEYS[2], ARGV[1])
return 1`;

export async function initializeInvocationOwnerRecovery(redis: RedisClient, rebuild = false): Promise<void> {
  if (!rebuild && (await redis.get(keys.ownerRecoveryComplete())) === '1') return;
  if (rebuild) await redis.del(keys.ownerRecoveryDue());
  const prefix = redis.options.keyPrefix ?? '';
  let cursor = '0';
  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', `${prefix}invoc:*`, 'COUNT', 100);
    cursor = next;
    const batch = redis.pipeline();
    for (const fullKey of found) {
      const bare = fullKey.slice(prefix.length);
      if (bare.startsWith('invoc:running:') || bare.startsWith('invoc:running-threads:')) continue;
      batch.eval(PROJECT, 2, bare, keys.ownerRecoveryDue(), bare.slice('invoc:'.length));
    }
    for (const [error] of (await batch.exec()) ?? []) if (error) throw error;
  } while (cursor !== '0');
  await redis.set(keys.ownerRecoveryComplete(), '1');
}

/** Selection defers the original owner facts before returning; a crashed reader cannot create a hot retry. */
export async function listRunningForOwnerRecovery(
  redis: RedisClient,
  limit: number,
  now: number,
  nextAt: number,
): Promise<InvocationRecord[]> {
  await initializeInvocationOwnerRecovery(redis);
  const ids = await redis.zrangebyscore(keys.ownerRecoveryDue(), '-inf', now, 'LIMIT', 0, limit);
  const records: InvocationRecord[] = [];
  for (const id of ids) {
    const flat = (await redis.eval(CLAIM, 2, keys.detail(id), keys.ownerRecoveryDue(), id, now, nextAt)) as string[];
    if (!flat.length) continue;
    const data: Record<string, string> = {};
    for (let n = 0; n < flat.length; n += 2) data[flat[n]!] = flat[n + 1]!;
    try {
      const decoded = decodeInvocationHash([null, data], id, 'invocation owner recovery');
      if (decoded.kind === 'running') records.push(decoded.record);
    } catch {
      // Keep original malformed business bytes and the explicit disposition; no route or execution is invented.
      await redis.eval(PARK_INVALID, 2, keys.detail(id), keys.ownerRecoveryDue(), id, JSON.stringify(data));
    }
  }
  return records;
}

export async function observeInvocationOwner(
  redis: RedisClient,
  id: string,
  input: import('../ports/invocation-owner-health.js').InvocationOwnerHealthInput,
): Promise<import('../ports/invocation-owner-health.js').InvocationOwnerHealthReceipt | null> {
  const raw = await redis.eval(
    `${INVOCATION_OWNER_RECOVERY_LUA}
preflightOwnerRecovery(KEYS[2])
if redis.call('HGET', KEYS[1], 'id') ~= ARGV[1] or redis.call('HGET', KEYS[1], 'status') ~= 'running' then return '' end
local facts = ownerFacts(KEYS[1])
local wasParked = facts.disposition == 'needs_attention'
local changed = facts.signature ~= ARGV[2]
local silenceNew = ARGV[3] == '1' and not facts.silenceSignaled
facts.signature = ARGV[2]
if silenceNew then facts.silenceSignaled = true end
if ARGV[4] == '1' then facts.failures = facts.failures + 1 else facts.failures = 0 end
if facts.failures >= 5 then facts.disposition = 'needs_attention'; facts.reasonCode = 'owner_probe_failed' end
if facts.disposition and not wasParked then changed = true end
redis.call('HSET', KEYS[1], '_ownerRecovery', cjson.encode(facts))
if facts.disposition then redis.call('ZREM', KEYS[2], ARGV[1])
else redis.call('ZADD', KEYS[2], facts.nextAt, ARGV[1]) end
return cjson.encode({changed=changed, silenceNew=silenceNew, parked=facts.disposition == 'needs_attention'})`,
    2,
    keys.detail(id),
    keys.ownerRecoveryDue(),
    id,
    input.signature,
    input.silence ? '1' : '0',
    input.failed ? '1' : '0',
  );
  return raw
    ? (JSON.parse(String(raw)) as import('../ports/invocation-owner-health.js').InvocationOwnerHealthReceipt)
    : null;
}
