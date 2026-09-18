/**
 * Message Store Factory
 * REDIS_URL 有值 → RedisMessageStore
 * 无 → MessageStore (内存，现有行为不变)
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { type MessageAppendListener, type MessageDeletionHooks, MessageStore } from '../ports/MessageStore.js';
import type { RoutingFactProjector } from '../redis/RedisMessageStore.js';
import { RedisMessageStore } from '../redis/RedisMessageStore.js';

const log = createModuleLogger('message-store-factory');

export type AnyMessageStore = MessageStore | RedisMessageStore;

function resolveMessageTtlSeconds(): number | undefined {
  const raw = process.env.MESSAGE_TTL_SECONDS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    log.warn({ raw }, 'Invalid MESSAGE_TTL_SECONDS, using default');
    return undefined;
  }
  return Math.trunc(parsed);
}

export function createMessageStore(
  redis?: RedisClient,
  options?: {
    onAppend?: MessageAppendListener;
    /** F257 V1: async projection worker for embedded RoutingDecisionFacts (§4.5.1) — Redis mode only */
    routingFactProjection?: RoutingFactProjector;
  } & MessageDeletionHooks,
): AnyMessageStore {
  if (redis) {
    const ttlSeconds = resolveMessageTtlSeconds();
    return new RedisMessageStore(redis, {
      ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
      onAppend: options?.onAppend,
      ...(options?.routingFactProjection ? { routingFactProjection: options.routingFactProjection } : {}),
      ...(options?.onBeforeHardDelete ? { onBeforeHardDelete: options.onBeforeHardDelete } : {}),
      ...(options?.onBeforeDeleteByThread ? { onBeforeDeleteByThread: options.onBeforeDeleteByThread } : {}),
    });
  }
  return new MessageStore({
    onAppend: options?.onAppend,
    ...(options?.onBeforeHardDelete ? { onBeforeHardDelete: options.onBeforeHardDelete } : {}),
    ...(options?.onBeforeDeleteByThread ? { onBeforeDeleteByThread: options.onBeforeDeleteByThread } : {}),
  });
}
