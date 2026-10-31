import type { RedisClient } from '@cat-cafe/shared/utils';
import { InvocationKeys } from '../redis-keys/invocation-keys.js';

const REMOVE_EMPTY_THREAD = `
if redis.call('SCARD', KEYS[2]) == 0 then
  return redis.call('SREM', KEYS[1], ARGV[1])
end
return 0
`;

// The domain codec has already proved this exact hash absent or non-live for
// the requested owner. Compare the entire observation, rather than duplicating
// its validity rules in Lua or letting an old read erase a retry/reassignment.
const REMOVE_UNCHANGED_RECORD = `
local observed = cjson.decode(ARGV[2])
local count = 0
for field, value in pairs(observed) do
  count = count + 1
  if redis.call('HGET', KEYS[1], field) ~= value then
    return 0
  end
end
if redis.call('HLEN', KEYS[1]) ~= count then
  return 0
end
return redis.call('SREM', KEYS[2], ARGV[1])
`;

export interface StaleRunningMember {
  id: string;
  observed: Record<string, string> | null;
}

/** Best-effort pruning may retain stale candidates; it must never remove a new live one. */
export async function pruneEmptyRunningThreads(
  redis: RedisClient,
  userId: string,
  threadIds: readonly string[],
): Promise<void> {
  const pipeline = redis.pipeline();
  for (const threadId of threadIds) {
    pipeline.eval(
      REMOVE_EMPTY_THREAD,
      2,
      InvocationKeys.runningThreadsByUser(userId),
      InvocationKeys.runningByThread(threadId, userId),
      threadId,
    );
  }
  await pipeline.exec();
}

export async function pruneUnchangedRunningMembers(
  redis: RedisClient,
  setKey: string,
  members: readonly StaleRunningMember[],
): Promise<void> {
  const pipeline = redis.pipeline();
  for (const member of members) {
    pipeline.eval(
      REMOVE_UNCHANGED_RECORD,
      2,
      InvocationKeys.detail(member.id),
      setKey,
      member.id,
      JSON.stringify(member.observed ?? {}),
    );
  }
  await pipeline.exec();
}
