import type { RedisClient } from '@cat-cafe/shared/utils';
import type { QueueLedgerEntry } from './QueueLedger.js';
import { QueueLedgerKeys } from './queue-ledger-keys.js';
import { hydrateQueueLedgerEntry, hydrateQueueMessageIndex } from './RedisQueueLedgerCodec.js';

export async function listRedisQueueLedgerEntries(redis: RedisClient, threadId: string): Promise<QueueLedgerEntry[]> {
  const ids = await redis.lrange(QueueLedgerKeys.order(threadId), 0, -1);
  if (ids.length === 0) return [];
  const raws = await redis.hmget(QueueLedgerKeys.entries(threadId), ...ids);
  return ids.map((id, index) => {
    const raw = raws[index];
    if (typeof raw !== 'string') throw new Error(`queue order references missing row: ${id}`);
    return hydrateQueueLedgerEntry(raw);
  });
}

export async function listAllRedisQueueLedgerEntries(
  redis: RedisClient,
  threadId: string,
): Promise<QueueLedgerEntry[]> {
  const raws = await redis.hvals(QueueLedgerKeys.entries(threadId));
  return raws
    .map(hydrateQueueLedgerEntry)
    .sort((left, right) => left.enqueuedAt - right.enqueuedAt || left.id.localeCompare(right.id));
}

export async function getRedisQueueLedgerEntriesByMessageIds(
  redis: RedisClient,
  threadId: string,
  messageIds: readonly string[],
): Promise<Map<string, QueueLedgerEntry[]>> {
  const uniqueMessageIds = [...new Set(messageIds.filter((messageId) => messageId.length > 0))];
  const grouped = new Map<string, QueueLedgerEntry[]>();
  if (uniqueMessageIds.length === 0) return grouped;
  const rawIndexes = await redis.hmget(QueueLedgerKeys.messageIndex(threadId), ...uniqueMessageIds);
  const entryIdsByMessage = new Map<string, string[]>();
  const allEntryIds = new Set<string>();
  for (let index = 0; index < uniqueMessageIds.length; index += 1) {
    const raw = rawIndexes[index];
    if (typeof raw !== 'string') continue;
    const messageId = uniqueMessageIds[index];
    if (!messageId) throw new Error('queue message index result length mismatch');
    const entryIds = hydrateQueueMessageIndex(raw, messageId);
    entryIdsByMessage.set(messageId, entryIds);
    for (const entryId of entryIds) allEntryIds.add(entryId);
  }
  if (allEntryIds.size === 0) return grouped;
  const orderedEntryIds = [...allEntryIds];
  const raws = await redis.hmget(QueueLedgerKeys.entries(threadId), ...orderedEntryIds);
  const entriesById = new Map<string, QueueLedgerEntry>();
  for (let index = 0; index < orderedEntryIds.length; index += 1) {
    const entryId = orderedEntryIds[index];
    if (!entryId) throw new Error('queue entry result length mismatch');
    const raw = raws[index];
    if (typeof raw !== 'string') throw new Error(`queue message index references missing row: ${entryId}`);
    entriesById.set(entryId, hydrateQueueLedgerEntry(raw));
  }
  for (const [messageId, entryIds] of entryIdsByMessage) {
    const entries = entryIds.map((entryId) => {
      const entry = entriesById.get(entryId);
      if (!entry) throw new Error(`queue message index references missing row: ${entryId}`);
      return entry;
    });
    if (entries.some((entry) => entry.payload.messageId !== messageId)) {
      throw new Error(`queue message index identity mismatch: ${messageId}`);
    }
    grouped.set(messageId, entries);
  }
  return grouped;
}

export async function listRedisQueueLedgerThreadIds(redis: RedisClient, keyPrefix: string): Promise<string[]> {
  const threadIds = new Set<string>();
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${keyPrefix}queue:{*}:order`, 'COUNT', 200);
    cursor = nextCursor;
    for (const key of keys) {
      const localKey = keyPrefix && key.startsWith(keyPrefix) ? key.slice(keyPrefix.length) : key;
      const match = /^queue:\{(.+)\}:order$/.exec(localKey);
      if (match?.[1]) threadIds.add(decodeURIComponent(match[1]));
    }
  } while (cursor !== '0');
  return [...threadIds].sort();
}

export async function getRedisQueueLedgerEntry(
  redis: RedisClient,
  threadId: string,
  entryId: string,
): Promise<QueueLedgerEntry | null> {
  const raw = await redis.hget(QueueLedgerKeys.entries(threadId), entryId);
  return raw ? hydrateQueueLedgerEntry(raw) : null;
}
