import type { RedisClient } from '@cat-cafe/shared/utils';
import type { IMessageStore, StoredMessage, ThreadMessageReadOptions } from '../ports/MessageStore.js';

// Seek the exclusive (score, id) boundary even after deletion or delivery-time re-scoring.
// Read-only and atomic: no sentinel members, owner state changes or payload hydration.
const BEFORE_RANGE = `
-- artifact cursor range
local timestamp = tonumber(ARGV[1])
local id = ARGV[2]
local score = redis.call('ZSCORE', KEYS[1], id)
local rank
if score and tonumber(score) == timestamp then
  rank = redis.call('ZREVRANK', KEYS[1], id)
else
  local low = 0
  local high = redis.call('ZCARD', KEYS[1])
  while low < high do
    local middle = math.floor((low + high) / 2)
    local row = redis.call('ZREVRANGE', KEYS[1], middle, middle, 'WITHSCORES')
    local value = tonumber(row[2])
    if value > timestamp or (value == timestamp and row[1] >= id) then
      low = middle + 1
    else
      high = middle
    end
  end
  rank = low - 1
end
local start = rank + 1 + tonumber(ARGV[3])
return redis.call('ZREVRANGE', KEYS[1], start, start + tonumber(ARGV[4]) - 1, 'WITHSCORES')
`;

export async function readArtifactBeforeRange(
  redis: RedisClient,
  key: string,
  timestamp: number,
  id: string,
  offset: number,
  count: number,
): Promise<string[]> {
  const rows = await redis.eval(BEFORE_RANGE, 1, key, String(timestamp), id, String(offset), String(count));
  if (!Array.isArray(rows) || rows.length % 2 !== 0 || !rows.every((value) => typeof value === 'string'))
    throw new Error('Artifact cursor range unavailable');
  return rows;
}

/** Fill a visible page through the canonical raw cursor without re-reading newer timestamp ties. */
export async function readArtifactMessagePage(
  store: Pick<IMessageStore, 'getByThreadBeforeBounded'>,
  threadId: string,
  limit: number,
  userId: string | undefined,
  options: ThreadMessageReadOptions,
  before?: { timestamp: number; id?: string },
): Promise<StoredMessage[]> {
  const descending: StoredMessage[] = [];
  let cursor = before;
  while (descending.length < limit) {
    const remaining = limit - descending.length;
    const page = await store.getByThreadBeforeBounded(
      threadId,
      cursor?.timestamp ?? Number.MAX_SAFE_INTEGER,
      remaining,
      cursor?.id,
      userId,
      remaining,
      options,
    );
    for (let index = page.messages.length - 1; index >= 0; index--) descending.push(page.messages[index]!);
    if (page.exhausted) break;
    if (!page.nextCursor || (page.nextCursor.id === cursor?.id && page.nextCursor.timestamp === cursor.timestamp))
      throw new Error('Artifact message page made no progress');
    cursor = page.nextCursor;
  }
  return descending.reverse();
}
