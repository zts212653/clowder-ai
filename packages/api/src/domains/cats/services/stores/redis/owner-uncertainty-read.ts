import type { RedisClient } from '@cat-cafe/shared/utils';
import type { StoredMessage, ThreadMessageReadOptions } from '../ports/MessageStore.js';
import { resolveThreadMessageVisibility } from '../visibility.js';
import { READ_OWNER_UNCERTAINTY_LUA } from './owner-uncertainty-lua.js';

export async function readOwnerUncertainty(input: {
  redis: RedisClient;
  threadId: string;
  userId?: string;
  limit: number;
  options: ThreadMessageReadOptions;
  hydrate: (ids: string[]) => Promise<StoredMessage[]>;
}): Promise<StoredMessage[]> {
  if (!input.userId) return [];
  const since = input.options.ownerUncertaintySinceMs ?? 0;
  if (!Number.isSafeInteger(since) || since < 0) throw new Error('Invalid owner uncertainty time');
  const index = `msg:owner-uncertainty:${input.threadId}`;
  const ids = await input.redis.eval(
    READ_OWNER_UNCERTAINTY_LUA,
    3,
    `msg:thread:${input.threadId}`,
    index,
    `${index}:version`,
    input.redis.options.keyPrefix ?? '',
    String(since),
  );
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))
    throw new Error('Owner uncertainty index reply invalid');
  const rows = await input.hydrate(ids.slice(0, 256));
  const visible = resolveThreadMessageVisibility(input.options, input.userId);
  const result = rows.filter((row) => row.threadId === input.threadId && !row.deletedAt && visible(row));
  if (result.length < input.limit && ids.length > 256) throw new Error('Owner uncertainty read saturated');
  return result.slice(0, input.limit);
}
