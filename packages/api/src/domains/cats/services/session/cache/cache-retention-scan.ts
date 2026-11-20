import type { RedisClient } from '@cat-cafe/shared/utils';

// Scores order discovery only; the durable candidate/window retains its canonical times.
// Append after the current tail, including indexes created with timestamp scores.
export const APPEND_RETENTION_INDEX = `
local function appendIndex(key, id)
  if redis.call('ZSCORE', key, id) then return end
  local tail = redis.call('ZREVRANGE', key, 0, 0, 'WITHSCORES')
  local score = 0
  if #tail > 0 then score = tonumber(tail[2]) + 1 end
  redis.call('ZADD', key, score, id)
end
`;

const ROTATE_PAGE = `
local count = redis.call('ZCARD', KEYS[1])
local ids = redis.call('ZRANGE', KEYS[1], 0, 255)
if #ids > 0 then
  local tail = redis.call('ZREVRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local score = tonumber(tail[2])
  for _, id in ipairs(ids) do
    score = score + 1
    redis.call('ZADD', KEYS[1], score, id)
  end
end
return {count, unpack(ids)}
`;

/** Atomically rotate one bounded page behind unseen work. New arrivals join the tail. */
export async function scanRetentionIndex(
  redis: RedisClient,
  key: string,
): Promise<{ ids: string[]; complete: boolean }> {
  const [count, ...ids] = (await redis.eval(ROTATE_PAGE, 1, key)) as [number, ...string[]];
  return { ids, complete: count > 0 && count <= 256 };
}
