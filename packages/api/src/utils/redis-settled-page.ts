import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  assertSettledHistoryPageOptions,
  type SettledHistoryPageOptions,
  type SettledHistorySourcePage,
} from './settled-history-page.js';

/** Binary search and bounded read run in one Redis snapshot. No rank/offset is kept in a cursor. */
const READ_PAGE = `
local size = redis.call('ZCARD', KEYS[1])
local start = 0
if ARGV[1] ~= '' then
  local boundary = tonumber(ARGV[1])
  local low, high = 0, size
  while low < high do
    local mid = math.floor((low + high) / 2)
    local item = redis.call('ZREVRANGE', KEYS[1], mid, mid, 'WITHSCORES')
    local score = tonumber(item[2])
    local alreadySeen = score > boundary or (score == boundary and ARGV[3] == 'exclusive' and item[1] >= ARGV[2])
    if alreadySeen then low = mid + 1 else high = mid end
  end
  start = low
end
return redis.call('ZREVRANGE', KEYS[1], start, start + tonumber(ARGV[4]), 'WITHSCORES')
`;

export async function readRedisSettledPage<T>(
  redis: RedisClient,
  index: string,
  options: SettledHistoryPageOptions,
  read: (id: string, decidedAt: number) => Promise<T | null>,
): Promise<SettledHistorySourcePage<T>> {
  assertSettledHistoryPageOptions(options);
  const before = options.before;
  const raw = await redis.eval(
    READ_PAGE,
    1,
    index,
    before ? String(before.decidedAt) : '',
    before?.proposalId ?? '',
    before?.proposalId === null ? 'inclusive-time' : 'exclusive',
    String(options.limit),
  );
  if (!Array.isArray(raw) || raw.length % 2 !== 0) throw new Error('invalid settled index page');
  const entries = Array.from({ length: raw.length / 2 }, (_, position) => {
    const proposalId: unknown = raw[position * 2];
    const decidedAt = Number(raw[position * 2 + 1]);
    if (typeof proposalId !== 'string' || !Number.isSafeInteger(decidedAt) || decidedAt < 0)
      throw new Error('invalid settled index entry');
    return { proposalId, decidedAt };
  });
  const scanned = entries.slice(0, options.limit);
  // A failed sibling must not leave canonical reads running past request close.
  const outcomes = await Promise.allSettled(scanned.map((entry) => read(entry.proposalId, entry.decidedAt)));
  const failure = outcomes.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  const records: T[] = [];
  for (const outcome of outcomes)
    if (outcome.status === 'fulfilled' && outcome.value !== null) records.push(outcome.value);
  return { records, frontier: scanned.at(-1) ?? null, hasMore: entries.length > options.limit };
}
