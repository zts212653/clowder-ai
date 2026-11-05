import type { RedisClient } from '@cat-cafe/shared/utils';
import { SettledIndexPreparingError } from './redis-settled-index.js';

interface Guard {
  key: string;
  fields: Record<string, string | number | undefined>;
}
const RECONCILE = `
if redis.call('ZSCORE',KEYS[1],ARGV[1])~=ARGV[2] then return 0 end
local guards=cjson.decode(ARGV[4])
for _,guard in ipairs(guards) do
  for field,expected in pairs(guard.fields) do
    if (redis.call('HGET',KEYS[guard.keyIndex],field) or '')~=expected then return 0 end
  end
end
redis.call('ZADD',KEYS[1],ARGV[3],ARGV[1])
return 1
`;

/** Repair only a derived score, guarded by every canonical field used to calculate it. Never changes a decision. */
export async function reconcileSettledIndexTime(
  redis: RedisClient,
  index: string,
  id: string,
  observed: number,
  canonical: number,
  guards: Guard[],
): Promise<void> {
  if (observed === canonical) return;
  if (!Number.isSafeInteger(canonical) || canonical < 0) throw new Error('Invalid canonical settled time');
  const keys = [index];
  const expected = guards.map((guard) => ({
    keyIndex: keys.push(guard.key),
    fields: Object.fromEntries(
      Object.entries(guard.fields).map(([field, value]) => [field, value === undefined ? '' : String(value)]),
    ),
  }));
  await redis.eval(RECONCILE, keys.length, ...keys, id, String(observed), String(canonical), JSON.stringify(expected));
  // A page sorted with the old score cannot be returned, even if the bounded repair succeeded.
  throw new SettledIndexPreparingError();
}
