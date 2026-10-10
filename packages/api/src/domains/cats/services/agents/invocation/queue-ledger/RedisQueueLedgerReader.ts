import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  type QueueLedgerEnqueueResult,
  type QueueLedgerEntry,
  queueLedgerAdmissionFingerprint,
  queueLedgerAdmissionsMatch,
} from './QueueLedger.js';
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

/**
 * Confirm what an atomic enqueue already decided was a replay.
 *
 * The Lua script answers "every identity was already settled" without shipping the stored rows
 * back, so the verdict still has to be checked against the rows on disk: same envelope is a
 * replay, a different one reusing the ids is a conflict. A missing row here means the atomic
 * preflight and the follow-up read disagree, which is corruption rather than a normal outcome.
 */
export async function verifyRedisQueueLedgerReplay(
  redis: RedisClient,
  threadId: string,
  entries: readonly QueueLedgerEntry[],
): Promise<QueueLedgerEnqueueResult> {
  const raws = await redis.hmget(QueueLedgerKeys.entries(threadId), ...entries.map((entry) => entry.id));
  // A retired `private_input` row is the reason receipts exist: the row is removed on purpose once
  // its last target reaches processing, so a missing row here is only corruption when no receipt
  // settled the identity either. Where a receipt did, it carries the verdict the row would have.
  const receipts = await redis.hmget(QueueLedgerKeys.privateAdmissions(threadId), ...entries.map((entry) => entry.id));
  const verified = entries.map((input, index) => {
    const raw = raws[index];
    if (typeof raw === 'string') {
      const stored = hydrateQueueLedgerEntry(raw);
      return { matches: queueLedgerAdmissionsMatch(stored, input), live: stored };
    }
    const receipt = receipts[index];
    if (input.kind !== 'private_input' || typeof receipt !== 'string') {
      throw new Error('Queue replay identity vanished after atomic preflight');
    }
    // The row is gone on purpose, so this identity has no entry left to hand back. Returning the
    // incoming envelope instead would read as freshly queued work and start a second execution —
    // the exact duplicate the receipt exists to prevent.
    return { matches: receipt === queueLedgerAdmissionFingerprint(input), live: undefined };
  });
  if (!verified.every((result) => result.matches)) return { outcome: 'conflict', entries: [] };
  return { outcome: 'replayed', entries: verified.flatMap((result) => (result.live ? [result.live] : [])) };
}
