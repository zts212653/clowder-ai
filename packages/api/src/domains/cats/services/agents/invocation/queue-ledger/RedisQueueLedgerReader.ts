import type { RedisClient } from '@cat-cafe/shared/utils';
import type { QueueLedgerEntry } from './QueueLedger.js';
import { QueueLedgerKeys } from './queue-ledger-keys.js';
import { GET_QUEUE_ROWS_BY_MESSAGE_IDS_LUA, LIST_QUEUE_ROWS_LUA } from './queue-ledger-redis-scripts.js';
import { hydrateQueueLedgerEntry } from './RedisQueueLedgerCodec.js';

function parseSerializedRows(raw: unknown, operation: string): QueueLedgerEntry[] {
  if (typeof raw !== 'string') throw new Error(`${operation} returned a non-string snapshot`);
  const decoded: unknown = JSON.parse(raw);
  if (!Array.isArray(decoded) || decoded.some((value) => typeof value !== 'string')) {
    throw new Error(`${operation} returned an invalid snapshot`);
  }
  return decoded.map(hydrateQueueLedgerEntry);
}

export async function listRedisQueueLedgerEntries(redis: RedisClient, threadId: string): Promise<QueueLedgerEntry[]> {
  const raw = await redis.eval(
    LIST_QUEUE_ROWS_LUA,
    2,
    QueueLedgerKeys.entries(threadId),
    QueueLedgerKeys.order(threadId),
  );
  return parseSerializedRows(raw, 'Queue order read');
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
  const raw = await redis.eval(
    GET_QUEUE_ROWS_BY_MESSAGE_IDS_LUA,
    2,
    QueueLedgerKeys.entries(threadId),
    QueueLedgerKeys.messageIndex(threadId),
    ...uniqueMessageIds,
  );
  if (typeof raw !== 'string') throw new Error('Queue message-index read returned a non-string snapshot');
  const decoded: unknown = JSON.parse(raw);
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('Queue message-index read returned an invalid snapshot');
  }
  const rowsByMessage = decoded as Record<string, unknown>;
  for (const messageId of uniqueMessageIds) {
    const serializedRows = rowsByMessage[messageId];
    if (serializedRows === undefined) continue;
    if (!Array.isArray(serializedRows) || serializedRows.some((value) => typeof value !== 'string')) {
      throw new Error(`Queue message index returned invalid rows: ${messageId}`);
    }
    const entries = serializedRows.map((value) => hydrateQueueLedgerEntry(value as string));
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
