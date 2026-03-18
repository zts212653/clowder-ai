/**
 * Message Store Factory
 * REDIS_URL 有值 → RedisMessageStore
 * 无 → MessageStore (内存，现有行为不变)
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { MessageStore } from '../ports/MessageStore.js';
import { RedisMessageStore } from '../redis/RedisMessageStore.js';

export type AnyMessageStore = MessageStore | RedisMessageStore;

function resolveMessageTtlSeconds(): number | undefined {
  const raw = process.env.MESSAGE_TTL_SECONDS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(`[MessageStoreFactory] Invalid MESSAGE_TTL_SECONDS='${raw}', using default`);
    return undefined;
  }
  return Math.trunc(parsed);
}

export function createMessageStore(
  redis?: RedisClient,
  options?: { onAppend?: (msg: { id: string; threadId: string; timestamp: number }) => void },
): AnyMessageStore {
  if (redis) {
    const ttlSeconds = resolveMessageTtlSeconds();
    return new RedisMessageStore(redis, {
      ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
      onAppend: options?.onAppend,
    });
  }
  return new MessageStore({ onAppend: options?.onAppend });
}
