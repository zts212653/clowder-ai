import type { CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
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
  const scorePipeline = redis.pipeline();
  for (const cursor of cursors) scorePipeline.zscore(MessageKeys.thread(cursor.threadId), cursor.afterId);
  const scoreResults = (await scorePipeline.exec()) as PipelineResults;
  const scores = cursors.map((_, index) => readPipelineValue<string | null>(scoreResults, index, 'Unread score'));

  type RangePlan =
    | { kind: 'expired'; commandIndex: number }
    | { kind: 'scored'; sameScoreIndex: number; higherScoreIndex: number };
  const rangePipeline = redis.pipeline();
  const rangePlans: RangePlan[] = [];
  let commandIndex = 0;
  for (const [index, cursor] of cursors.entries()) {
    const score = scores[index];
    if (score === null) {
      rangePipeline.zrange(MessageKeys.thread(cursor.threadId), 0, -1);
      rangePlans.push({ kind: 'expired', commandIndex: commandIndex++ });
      continue;
    }
    rangePipeline.zrangebyscore(MessageKeys.thread(cursor.threadId), score, score);
    const sameScoreIndex = commandIndex++;
    rangePipeline.zrangebyscore(MessageKeys.thread(cursor.threadId), `(${score}`, '+inf');
    rangePlans.push({ kind: 'scored', sameScoreIndex, higherScoreIndex: commandIndex++ });
  }

  const rangeResults = (await rangePipeline.exec()) as PipelineResults;
  const idsByThread = new Map<string, string[]>();
  for (const [index, cursor] of cursors.entries()) {
    const plan = rangePlans[index];
    if (!plan) throw new Error(`Unread range plan missing cursor ${index}`);
    if (plan.kind === 'expired') {
      const allIds = readPipelineValue<string[]>(rangeResults, plan.commandIndex, 'Unread range');
      idsByThread.set(
        cursor.threadId,
        allIds.filter((id) => id > cursor.afterId),
      );
      continue;
    }
    const sameScoreIds = readPipelineValue<string[]>(rangeResults, plan.sameScoreIndex, 'Unread range');
    const higherScoreIds = readPipelineValue<string[]>(rangeResults, plan.higherScoreIndex, 'Unread range');
    idsByThread.set(cursor.threadId, [
      ...sameScoreIds.filter((id) => id !== cursor.afterId && id > cursor.afterId),
      ...higherScoreIds,
    ]);
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
