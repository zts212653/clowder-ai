import { randomUUID } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';

export const SETTLED_INDEX_BATCH = 200;
export class SettledIndexPreparingError extends Error {
  readonly statusCode = 503;
  readonly code = 'APPROVAL_HISTORY_PREPARING';
  constructor() {
    super('Handled history is being prepared');
  }
}
export type SettledIndexEntry = { indexKey: string; id: string; score: number };
export type SettledIndexSource = {
  progressKey: string;
  prefix: string;
  type: 'hash' | 'string';
  entry: (raw: unknown, key: string) => Promise<SettledIndexEntry | null> | SettledIndexEntry | null;
};
type Progress = { cursor: string; pending: string[]; complete: boolean };

const COMMIT_BATCH = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
if (redis.call('GET', KEYS[1]) or '') ~= ARGV[2] then return 0 end
local entries = cjson.decode(ARGV[4])
for _, entry in ipairs(entries) do
  local t = redis.call('TYPE', KEYS[entry.keyIndex]).ok
  if t ~= 'none' and t ~= 'zset' then return redis.error_reply('history index type conflict') end
end
for _, entry in ipairs(entries) do
  local current = entry.sourceType == 'string' and redis.call('GET', KEYS[entry.sourceIndex]) or redis.call('HGET', KEYS[entry.sourceIndex], 'status')
  if current == entry.expected then
    redis.call('ZADD', KEYS[entry.keyIndex], 'NX', entry.score, entry.id)
  end
end
redis.call('SET', KEYS[1], ARGV[3])
redis.call('DEL', KEYS[2])
return 1
`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

/** One resumable batch, at most 200 detail reads. Incomplete migration is unavailable, never false empty history. */
export async function advanceSettledIndex(redis: RedisClient, source: SettledIndexSource): Promise<boolean> {
  const PROGRESS = source.progressKey,
    LOCK = `${PROGRESS}:lock`;
  const prior = await redis.get(PROGRESS);
  const progress: Progress = prior ? JSON.parse(prior) : { cursor: '0', pending: [], complete: false };
  if (progress.complete) return true;
  const token = randomUUID();
  if (!(await redis.set(LOCK, token, 'PX', 30000, 'NX'))) return false;
  try {
    const physicalPrefix = `${redis.options.keyPrefix ?? ''}${source.prefix}`;
    if (!progress.pending.length) {
      const pattern = physicalPrefix.replace(/[\\*?[\]]/gu, '\\$&') + '*';
      const [cursor, keys] = await redis.scan(
        progress.cursor,
        'MATCH',
        pattern,
        'COUNT',
        SETTLED_INDEX_BATCH,
        'TYPE',
        source.type,
      );
      progress.cursor = cursor;
      progress.pending = keys.map((key) => key.slice((redis.options.keyPrefix ?? '').length));
    }
    const batch = progress.pending.splice(0, SETTLED_INDEX_BATCH);
    const pipeline = redis.pipeline();
    for (const key of batch) {
      if (source.type === 'hash') pipeline.hgetall(key);
      else pipeline.get(key);
    }
    const values = batch.length ? await pipeline.exec() : [];
    if (!values || values.length !== batch.length) throw new Error('settled history backfill read incomplete');
    const keys = [PROGRESS, LOCK];
    const entries: {
      keyIndex: number;
      sourceIndex: number;
      sourceType: string;
      expected: unknown;
      score: number;
      id: string;
    }[] = [];
    for (const [index, value] of values.entries()) {
      if (value[0]) throw value[0];
      const raw = value[1];
      if (!raw || (typeof raw === 'object' && !Object.keys(raw).length)) continue;
      const sourceKey = batch[index];
      const entry = await source.entry(raw, sourceKey);
      if (!entry) continue;
      if (!Number.isFinite(entry.score)) throw new Error('invalid settled index timestamp');
      let keyIndex = keys.indexOf(entry.indexKey);
      if (keyIndex === -1) keyIndex = keys.push(entry.indexKey) - 1;
      let sourceIndex = keys.indexOf(sourceKey);
      if (sourceIndex === -1) sourceIndex = keys.push(sourceKey) - 1;
      const expected = source.type === 'string' ? raw : (raw as Record<string, string>).status;
      entries.push({
        keyIndex: keyIndex + 1,
        sourceIndex: sourceIndex + 1,
        sourceType: source.type,
        expected,
        score: entry.score,
        id: entry.id,
      });
    }
    progress.complete = progress.cursor === '0' && progress.pending.length === 0;
    const committed = await redis.eval(
      COMMIT_BATCH,
      keys.length,
      ...keys,
      token,
      prior ?? '',
      JSON.stringify(progress),
      JSON.stringify(entries),
    );
    return Number(committed) === 1 && progress.complete;
  } finally {
    await redis.eval(RELEASE, 1, LOCK, token);
  }
}
