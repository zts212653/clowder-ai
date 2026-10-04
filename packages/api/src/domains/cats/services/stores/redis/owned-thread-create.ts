import type { RedisClient } from '@cat-cafe/shared/utils';
import type { Thread } from '../ports/ThreadStore.js';
import { ThreadKeys } from '../redis-keys/thread-keys.js';
import { threadProjectIndexKey } from './thread-project-index.js';

const CREATE_OWNED_THREAD = `
if redis.call('EXISTS', KEYS[5]) == 1 then return -1 end
if redis.call('HEXISTS', KEYS[1], 'id') == 1 then return 0 end
redis.call('HSET', KEYS[1], unpack(cjson.decode(ARGV[1])))
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
redis.call('SADD', KEYS[6], ARGV[3])
if ARGV[4] == '1' then redis.call('ZADD', KEYS[3], ARGV[2], ARGV[3]) end
local participants = cjson.decode(ARGV[5])
if #participants > 0 then redis.call('SADD', KEYS[4], unpack(participants)) end
local ttl = tonumber(ARGV[6])
if ttl > 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
  redis.call('EXPIRE', KEYS[4], ttl)
end
return 1
`;

/** Detail, discovery indexes and initial participants become visible in one transaction. */
export async function createOwnedThreadAtomically(
  redis: RedisClient,
  thread: Thread,
  fields: Record<string, string>,
  ttlSeconds: number | null,
) {
  const result = await redis.eval(
    CREATE_OWNED_THREAD,
    6,
    ThreadKeys.detail(thread.id),
    ThreadKeys.userList(thread.createdBy),
    ThreadKeys.children(thread.parentThreadId ?? thread.id),
    ThreadKeys.participants(thread.id),
    ThreadKeys.tombstone(thread.id),
    threadProjectIndexKey(thread.projectPath),
    JSON.stringify(Object.entries(fields).flat()),
    String(thread.createdAt),
    thread.id,
    thread.parentThreadId ? '1' : '0',
    JSON.stringify(thread.participants),
    String(ttlSeconds ?? 0),
  );
  if (result === -1) {
    throw Object.assign(new Error('Deleted execution Thread cannot be recreated by replay'), {
      code: 'OWNER_ADMISSION_UNAVAILABLE',
    });
  }
}
