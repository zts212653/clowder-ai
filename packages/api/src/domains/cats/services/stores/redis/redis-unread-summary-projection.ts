import type { CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { parseCursor } from '../cursor.js';
import type { ThreadUnreadMessageProjection, ThreadUnreadProjectionCursor } from '../ports/MessageStore.js';
import { MessageKeys } from '../redis-keys/message-keys.js';
import { isSystemUserMessage } from '../visibility.js';

type PipelineResults = Array<[Error | null, unknown]> | null;

function readPipelineValue<T>(results: PipelineResults, index: number, label: string): T {
  if (!results) throw new Error(`${label} pipeline returned no results`);
  const entry = results[index];
  if (!entry) throw new Error(`${label} pipeline omitted command ${index}`);
  const [error, value] = entry;
  if (error) throw error;
  return value as T;
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

  type RangePlan =
    | { kind: 'expired'; commandIndex: number }
    | { kind: 'scored'; sameScoreIndex: number; higherScoreIndex: number };
  const rangePipeline = redis.pipeline();
  const rangePlans: RangePlan[] = [];
  let commandIndex = 0;
  for (const [index, { cursor }] of cursorPlans.entries()) {
    const position = positions[index];
    if (position === null) {
      rangePipeline.zrange(MessageKeys.threadVisibility(cursor.threadId), 0, -1);
      rangePlans.push({ kind: 'expired', commandIndex: commandIndex++ });
      continue;
    }
    rangePipeline.zrangebyscore(MessageKeys.threadVisibility(cursor.threadId), position, position);
    const sameScoreIndex = commandIndex++;
    rangePipeline.zrangebyscore(MessageKeys.threadVisibility(cursor.threadId), `(${position}`, '+inf');
    rangePlans.push({ kind: 'scored', sameScoreIndex, higherScoreIndex: commandIndex++ });
  }

  const rangeResults = (await rangePipeline.exec()) as PipelineResults;
  const idsByThread = new Map<string, string[]>();
  for (const [index, { cursor, parsed }] of cursorPlans.entries()) {
    const plan = rangePlans[index];
    if (!plan) throw new Error(`Unread range plan missing cursor ${index}`);
    if (plan.kind === 'expired') {
      const allIds = readPipelineValue<string[]>(rangeResults, plan.commandIndex, 'Unread range');
      // Match getByThreadAfter's fully-pruned fallback: scan from visibility
      // start. Raw-ID filtering would recreate the C -> Q -> C cursor cycle.
      idsByThread.set(cursor.threadId, allIds);
      continue;
    }
    const sameScoreIds = readPipelineValue<string[]>(rangeResults, plan.sameScoreIndex, 'Unread range');
    const higherScoreIds = readPipelineValue<string[]>(rangeResults, plan.higherScoreIndex, 'Unread range');
    idsByThread.set(cursor.threadId, [...sameScoreIds.filter((id) => id > parsed.id), ...higherScoreIds]);
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
  const [messageUserId, catIdRaw, source, deletedAt, mentionsUser, deliveryStatus, origin] = fields;
  const catId = (catIdRaw || null) as CatId | null;
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
  const idsByThread = await projectMessageIds(redis, cursors);
  const fieldsById = await projectMessageFields(redis, idsByThread);

  return cursors.map(({ threadId }) => {
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
