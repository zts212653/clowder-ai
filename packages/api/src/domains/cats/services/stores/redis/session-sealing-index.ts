import type { RedisClient } from '@cat-cafe/shared/utils';
import { SessionChainKeys as keys } from '../redis-keys/session-chain-keys.js';

export const SEALING_INDEX_PREFLIGHT = `
local sealingIndexType = redis.call('TYPE', KEYS[#KEYS]).ok
if sealingIndexType ~= 'none' and sealingIndexType ~= 'zset' then
  return redis.error_reply('invalid_session_sealing_index')
end
`;

/** Reads owner facts inside the writer's Lua; the ZSET is only a rebuildable projection. */
export const PROJECT_SEALING_LUA = `
local function projectSealing(detail, id, index)
  if redis.call('HGET', detail, 'status') == 'sealing'
    and not redis.call('HGET', detail, '_sealingRecoveryDisposition') then
    local at = tonumber(redis.call('HGET', detail, 'updatedAt') or redis.call('HGET', detail, 'createdAt'))
    if at and redis.call('HGET', detail, 'id') == id then
      redis.call('ZADD', index, at, id)
    else
      redis.call('HSET', detail, '_sealingRecoveryDisposition', 'needs_attention',
        '_sealingRecoveryReason', 'invalid_sealing_record')
      redis.call('ZREM', index, id)
    end
  else
    redis.call('ZREM', index, id)
  end
end
`;

const PROJECT = `${SEALING_INDEX_PREFLIGHT}${PROJECT_SEALING_LUA}
projectSealing(KEYS[1], ARGV[1], KEYS[2])
return 1`;

/** Explicit census/rebuild only. A crash leaves the marker absent; concurrent writers project live facts. */
export async function initializeSessionSealing(
  redis: RedisClient,
  scanDetails: () => Promise<string[]>,
  rebuild = false,
): Promise<void> {
  if (!rebuild && (await redis.get(keys.sealingComplete())) === '1') return;
  if (rebuild) await redis.del(keys.sealing());
  const details = await scanDetails();
  for (let start = 0; start < details.length; start += 100) {
    const batch = redis.pipeline();
    for (const detail of details.slice(start, start + 100))
      batch.eval(PROJECT, 2, detail, keys.sealing(), detail.slice('session:'.length));
    for (const [error] of (await batch.exec()) ?? []) if (error) throw error;
  }
  await redis.set(keys.sealingComplete(), '1');
}

export async function listSessionSealing(redis: RedisClient, limit: number, before: number): Promise<string[]> {
  const ids = await redis.zrangebyscore(
    keys.sealing(),
    '-inf',
    before === Number.POSITIVE_INFINITY ? '+inf' : String(before),
    'LIMIT',
    0,
    limit,
  );
  if (!ids.length) return [];
  const batch = redis.pipeline();
  for (const id of ids) batch.eval(PROJECT, 2, keys.detail(id), keys.sealing(), id);
  for (const [error] of (await batch.exec()) ?? []) if (error) throw error;
  // Re-read only the bounded index slice: a concurrent terminal write must not be returned as work.
  return redis.zrangebyscore(
    keys.sealing(),
    '-inf',
    before === Number.POSITIVE_INFINITY ? '+inf' : String(before),
    'LIMIT',
    0,
    limit,
  );
}

export async function recordSessionSealingFailure(redis: RedisClient, id: string, expectedAt: number): Promise<void> {
  await redis.eval(
    `${SEALING_INDEX_PREFLIGHT}
if redis.call('HGET', KEYS[1], 'status') ~= 'sealing'
  or tonumber(redis.call('HGET', KEYS[1], 'updatedAt') or redis.call('HGET', KEYS[1], 'createdAt')) ~= tonumber(ARGV[2]) then return 0 end
local failures = redis.call('HINCRBY', KEYS[1], '_sealingRecoveryFailures', 1)
if failures >= 5 then
  redis.call('HSET', KEYS[1], '_sealingRecoveryDisposition', 'needs_attention',
    '_sealingRecoveryReason', 'sealing_recovery_failed')
  redis.call('ZREM', KEYS[2], ARGV[1])
end
return 1`,
    2,
    keys.detail(id),
    keys.sealing(),
    id,
    expectedAt,
  );
}

/** Bounded owner metadata, independent of decoding the business record. */
export async function listSessionSealingCandidates(
  redis: RedisClient,
  limit: number,
  before: number,
): Promise<{ id: string; expectedAt: number }[]> {
  const ids = await listSessionSealing(redis, limit, before);
  if (!ids.length) return [];
  const batch = redis.pipeline();
  for (const id of ids) batch.hmget(keys.detail(id), 'status', 'updatedAt', 'createdAt');
  const candidates: { id: string; expectedAt: number }[] = [];
  for (const [index, [error, fields]] of ((await batch.exec()) ?? []).entries()) {
    if (error) throw error;
    const [status, updatedAt, createdAt] = fields as (string | null)[];
    const at = Number(updatedAt ?? createdAt);
    const id = ids[index];
    if (id !== undefined && status === 'sealing' && Number.isFinite(at) && at <= before)
      candidates.push({ id, expectedAt: at });
  }
  return candidates;
}
