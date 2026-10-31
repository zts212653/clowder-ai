import type { CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { MessageKeys } from '../redis-keys/message-keys.js';

/** Read the recent mention window from existing canonical membership indexes. */
export async function readRecentMentionIds(
  redis: Pick<RedisClient, 'zinter' | 'zrevrange'>,
  catId: CatId,
  limit: number,
  userId?: string,
  threadId?: string,
): Promise<string[]> {
  const count = Math.ceil(limit);
  if (!(count > 0)) return [];
  const mentionKey = MessageKeys.mentions(catId);
  const keys = [
    mentionKey,
    ...(userId ? [MessageKeys.user(userId)] : []),
    ...(threadId ? [MessageKeys.thread(threadId)] : []),
  ];
  if (keys.length === 1)
    return (await redis.zrevrange(mentionKey, 0, Number.isFinite(count) ? count - 1 : -1)).reverse();
  // Filter membership inside Redis; thread/user scores do not affect mention
  // ordering. ZINTER is read-only and creates no temporary keys or new ledger.
  const ids = await redis.zinter(
    keys.length,
    ...keys,
    'WEIGHTS',
    ...keys.map((_, index) => (index === 0 ? 1 : 0)),
    'AGGREGATE',
    'SUM',
  );
  return ids.slice(-count);
}
