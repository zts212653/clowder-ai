import type { CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { parseCursor } from '../cursor.js';
import type {
  StoredMessage,
  ThreadUnreadMessageProjection,
  ThreadUnreadProjectionCursor,
} from '../ports/MessageStore.js';
import { MessageKeys } from '../redis-keys/message-keys.js';
import { isDurableOwnerReadEvidence, isSystemUserMessage, passesManagedHoldViewerBoundary } from '../visibility.js';
import { safeParseConnectorSource, safeParseExtra, safeParseQueueCustody } from './redis-message-parsers.js';

type PipelineResults = Array<[Error | null, unknown]> | null;

function readPipelineValue<T>(results: PipelineResults, index: number, label: string): T {
  if (!results) throw new Error(`${label} pipeline returned no results`);
  const entry = results[index];
  if (!entry) throw new Error(`${label} pipeline omitted command ${index}`);
  const [error, value] = entry;
  if (error) throw error;
  return value as T;
}

function resolveViewerBoundProjectionCursor(
  cursor: ThreadUnreadProjectionCursor,
  resultIndex: number | undefined,
  results: PipelineResults,
  userId: string,
): ThreadUnreadProjectionCursor {
  if (resultIndex === undefined || !cursor.fallbackAfterId) return cursor;
  const fields = readPipelineValue<Array<string | null>>(results, resultIndex, 'Unread anchor eligibility');
  if (fields.every((field) => field === null)) {
    // A pruned canonical anchor retains its encoded monotonic position.
    return cursor;
  }
  const [messageUserId, catIdRaw, source, deliveryStatus, origin, threadId, extra, queueCustody] = fields;
  const message = {
    userId: messageUserId ?? '',
    catId: (catIdRaw || null) as CatId | null,
    threadId: threadId ?? '',
    source: safeParseConnectorSource(source ?? undefined),
    extra: safeParseExtra(extra ?? undefined),
    queueCustody: safeParseQueueCustody(queueCustody ?? undefined),
    ...(deliveryStatus ? { deliveryStatus } : {}),
    ...(origin ? { origin } : {}),
  } as StoredMessage;
  const eligible =
    message.threadId === cursor.threadId &&
    isDurableOwnerReadEvidence(message) &&
    passesManagedHoldViewerBoundary(message, userId);
  return eligible ? cursor : { threadId: cursor.threadId, afterId: cursor.fallbackAfterId };
}

async function selectViewerBoundProjectionCursors(
  redis: RedisClient,
  cursors: readonly ThreadUnreadProjectionCursor[],
  userId: string,
): Promise<ThreadUnreadProjectionCursor[]> {
  const pipeline = redis.pipeline();
  const selected = [...cursors];
  const commandIndexByCursor = new Map<number, number>();
  let commandIndex = 0;
  for (const [index, cursor] of cursors.entries()) {
    if (!cursor.fallbackAfterId || cursor.fallbackAfterId === cursor.afterId) continue;
    let parsed: ReturnType<typeof parseCursor> = null;
    try {
      parsed = parseCursor(cursor.afterId);
    } catch {
      // A malformed durable anchor is not a scan frontier.
    }
    if (parsed?.version !== 2) {
      selected[index] = { threadId: cursor.threadId, afterId: cursor.fallbackAfterId };
      continue;
    }
    commandIndexByCursor.set(index, commandIndex++);
    pipeline.hmget(
      MessageKeys.detail(parsed.id),
      'userId',
      'catId',
      'source',
      'deliveryStatus',
      'origin',
      'threadId',
      'extra',
      'queueCustody',
    );
  }
  if (commandIndex === 0) return selected;

  const results = (await pipeline.exec()) as PipelineResults;
  return selected.map((cursor, index) =>
    resolveViewerBoundProjectionCursor(cursor, commandIndexByCursor.get(index), results, userId),
  );
}

async function projectMessageIds(
  redis: RedisClient,
  cursors: readonly ThreadUnreadProjectionCursor[],
): Promise<Map<string, string[]>> {
  const cursorPlans = cursors.map((cursor) => {
    const { afterId } = cursor;
    const parsed = parseCursor(afterId);
    if (!parsed) throw new Error('Unread projection cursor must not be empty');
    return { cursor, parsed };
  });

  // Resolve legacy v1 cursors in the same visibility domain as
  // RedisMessageStore.getByThreadAfter. HGET is authoritative when the cursor
  // member was evicted from the visibility ZSET; ZSCORE is the fallback for a
  // surviving index member whose message hash was pruned.
  const positionPipeline = redis.pipeline();
  for (const { cursor, parsed } of cursorPlans) {
    positionPipeline.hget(MessageKeys.detail(parsed.id), 'visibilitySeq');
    positionPipeline.zscore(MessageKeys.threadVisibility(cursor.threadId), parsed.id);
  }
  const positionResults = (await positionPipeline.exec()) as PipelineResults;
  const positions = cursorPlans.map(({ parsed }, index) => {
    if (parsed.version === 2) return parsed.seq;
    const hashSeq = readPipelineValue<string | null>(positionResults, index * 2, 'Unread visibility hash');
    const indexSeq = readPipelineValue<string | null>(positionResults, index * 2 + 1, 'Unread visibility score');
    const raw = hashSeq ?? indexSeq;
    return raw === null ? null : Number(raw);
  });

  type RangePlan = { kind: 'stale' } | { kind: 'scored'; sameScoreIndex: number; higherScoreIndex: number };
  const rangePipeline = redis.pipeline();
  const rangePlans: RangePlan[] = [];
  const idsByThread = new Map<string, string[]>();
  let commandIndex = 0;
  for (const [index, { cursor }] of cursorPlans.entries()) {
    const position = positions[index];
    if (position === null) {
      // #1304: Stale cursor — position can't be resolved in the visibility
      // index (message hash pruned AND ZSET membership evicted). Scanning
      // the entire visibility set (zrange 0 -1) produces phantom 99+ unread
      // badges for every old thread. The cursor was valid at some point; the
      // safe default is 0 unread, not "entire history is unread."
      idsByThread.set(cursor.threadId, []);
      rangePlans.push({ kind: 'stale' });
      continue;
    }
    rangePipeline.zrangebyscore(MessageKeys.threadVisibility(cursor.threadId), position, position);
    const sameScoreIndex = commandIndex++;
    rangePipeline.zrangebyscore(MessageKeys.threadVisibility(cursor.threadId), `(${position}`, '+inf');
    rangePlans.push({ kind: 'scored', sameScoreIndex, higherScoreIndex: commandIndex++ });
  }

  if (commandIndex > 0) {
    const rangeResults = (await rangePipeline.exec()) as PipelineResults;
    for (const [index, { cursor, parsed }] of cursorPlans.entries()) {
      const plan = rangePlans[index];
      if (!plan) throw new Error(`Unread range plan missing cursor ${index}`);
      if (plan.kind === 'stale') {
        // Already set to empty in the range-building loop
        continue;
      }
      const sameScoreIds = readPipelineValue<string[]>(rangeResults, plan.sameScoreIndex, 'Unread range');
      const higherScoreIds = readPipelineValue<string[]>(rangeResults, plan.higherScoreIndex, 'Unread range');
      idsByThread.set(cursor.threadId, [...sameScoreIds.filter((id) => id > parsed.id), ...higherScoreIds]);
    }
  }
  return idsByThread;
}

async function projectMessageFields(
  redis: RedisClient,
  idsByThread: ReadonlyMap<string, string[]>,
): Promise<Map<string, Array<string | null>>> {
  const uniqueIds = [...new Set([...idsByThread.values()].flat())];
  const fieldsById = new Map<string, Array<string | null>>();
  const batchSize = 1000;
  for (let offset = 0; offset < uniqueIds.length; offset += batchSize) {
    const batch = uniqueIds.slice(offset, offset + batchSize);
    const pipeline = redis.pipeline();
    for (const messageId of batch) {
      pipeline.hmget(
        MessageKeys.detail(messageId),
        'userId',
        'catId',
        'source',
        'deletedAt',
        'mentionsUser',
        'deliveryStatus',
        'origin',
        'threadId',
        'extra',
        'queueCustody',
      );
    }
    const results = (await pipeline.exec()) as PipelineResults;
    for (let index = 0; index < batch.length; index += 1) {
      const messageId = batch[index];
      if (!messageId) throw new Error(`Unread hash batch missing message ${index}`);
      fieldsById.set(messageId, readPipelineValue<Array<string | null>>(results, index, 'Unread hash'));
    }
  }
  return fieldsById;
}

function isProjectedUnread(fields: Array<string | null>, userId: string): { unread: boolean; mentioned: boolean } {
  const [
    messageUserId,
    catIdRaw,
    source,
    deletedAt,
    mentionsUser,
    deliveryStatus,
    origin,
    threadId,
    extra,
    queueCustody,
  ] = fields;
  const catId = (catIdRaw || null) as CatId | null;
  const managedHoldMessage = {
    userId: messageUserId ?? '',
    catId,
    threadId: threadId ?? '',
    source: safeParseConnectorSource(source ?? undefined),
    extra: safeParseExtra(extra ?? undefined),
    queueCustody: safeParseQueueCustody(queueCustody ?? undefined),
  };
  if (!passesManagedHoldViewerBoundary(managedHoldMessage, userId)) {
    return { unread: false, mentioned: false };
  }
  const visibleToUser = messageUserId === userId || isSystemUserMessage({ userId: messageUserId ?? '', catId });
  const timelinePublished =
    !deliveryStatus ||
    deliveryStatus === 'delivered' ||
    (deliveryStatus === 'queued' &&
      catId !== null &&
      catId !== 'system' &&
      messageUserId !== 'system' &&
      messageUserId !== 'scheduler' &&
      origin !== 'briefing');
  return {
    unread: visibleToUser && timelinePublished && !deletedAt && (catId !== null || !!source),
    mentioned: mentionsUser === '1',
  };
}

export async function projectRedisUnreadSummaries(
  redis: RedisClient,
  cursors: readonly ThreadUnreadProjectionCursor[],
  userId: string,
): Promise<ThreadUnreadMessageProjection[]> {
  if (cursors.length === 0) return [];
  const viewerBoundCursors = await selectViewerBoundProjectionCursors(redis, cursors, userId);
  const idsByThread = await projectMessageIds(redis, viewerBoundCursors);
  const fieldsById = await projectMessageFields(redis, idsByThread);

  return viewerBoundCursors.map(({ threadId }) => {
    let unreadCount = 0;
    let hasUserMention = false;
    for (const messageId of idsByThread.get(threadId) ?? []) {
      const fields = fieldsById.get(messageId);
      if (!fields) continue;
      const projected = isProjectedUnread(fields, userId);
      if (!projected.unread) continue;
      unreadCount += 1;
      if (projected.mentioned) hasUserMention = true;
    }
    return { threadId, unreadCount, hasUserMention };
  });
}
