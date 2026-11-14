import {
  applyWatcherThreadControlPatch,
  parseWatcherThreadControl,
  type WatcherThreadControl,
  type WatcherThreadControlPatch,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { ThreadKeys } from '../redis-keys/thread-keys.js';

const PATCH_LUA = `
if redis.call('HEXISTS', KEYS[1], 'id') == 0 then return '' end
local deleted = redis.call('HGET', KEYS[1], 'deletedAt')
if deleted and deleted ~= '' then return '' end
local raw = redis.call('HGET', KEYS[1], 'watcher')
local current = raw and cjson.decode(raw) or {revision = 0}
if current.revision ~= tonumber(ARGV[1]) then return '' end
redis.call('HSET', KEYS[1], 'watcher', ARGV[2])
return ARGV[2]
`;

export async function updateRedisWatcherThreadControl(
  redis: RedisClient,
  threadId: string,
  expectedRevision: number,
  patch: WatcherThreadControlPatch,
  metadata?: import('@cat-cafe/shared').WatcherControlWriteMetadata,
): Promise<WatcherThreadControl | null> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new Error('invalid watcher control revision');
  const key = ThreadKeys.detail(threadId);
  const raw = await redis.hget(key, 'watcher');
  const current = parseWatcherThreadControl(raw === null ? undefined : JSON.parse(raw));
  if (current.revision !== expectedRevision) return null;
  const next = applyWatcherThreadControlPatch(current, patch, metadata);
  const result = await redis.eval(PATCH_LUA, 1, key, String(expectedRevision), JSON.stringify(next));
  return typeof result === 'string' && result ? parseWatcherThreadControl(JSON.parse(result)) : null;
}
