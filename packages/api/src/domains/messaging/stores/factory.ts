/**
 * Plugin Messaging — store factory (K-1 / F288)
 * Same convention as MessageStoreFactory: Redis client present → Redis
 * implementations (production durability), absent → in-memory (dev semantics).
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { HostPublicationGate } from './host-publication-gate.js';
import {
  MemoryAppendLock,
  MemoryCursorStore,
  MemoryEventLogStore,
  MemoryHandleStore,
  MemoryLedgerStore,
} from './memory.js';
import type { MessagingStores } from './ports.js';
import { RedisAppendLock, RedisCursorStore, RedisEventLogStore, RedisHandleStore, RedisLedgerStore } from './redis.js';

export function createMessagingStores(redis?: RedisClient): MessagingStores {
  if (redis) {
    return {
      ledger: new RedisLedgerStore(redis),
      handles: new RedisHandleStore(redis),
      events: new RedisEventLogStore(redis),
      cursors: new RedisCursorStore(redis),
      appendLock: new RedisAppendLock(redis),
      publications: new HostPublicationGate(),
    };
  }
  return {
    ledger: new MemoryLedgerStore(),
    handles: new MemoryHandleStore(),
    events: new MemoryEventLogStore(),
    cursors: new MemoryCursorStore(),
    appendLock: new MemoryAppendLock(),
    publications: new HostPublicationGate(),
  };
}
