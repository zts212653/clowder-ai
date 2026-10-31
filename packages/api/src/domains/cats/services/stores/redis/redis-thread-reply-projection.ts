import type { CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { DEFAULT_THREAD_ID, type StoredMessage, type ThreadReplyProjection } from '../ports/MessageStore.js';
import { MessageKeys } from '../redis-keys/message-keys.js';
import { isSystemUserMessage, resolveThreadMessageVisibility } from '../visibility.js';
import {
  parseConnectorSourceField,
  safeParseExtra,
  safeParseLifecycleMetadata,
  safeParseMessageFrom,
} from './redis-message-parsers.js';
import { parseRedisNumber } from './redis-number.js';

const FIELDS = [
  'id',
  'threadId',
  'userId',
  'catId',
  'timestamp',
  'timelineOrderAt',
  'deletedAt',
  'deliveryStatus',
  'origin',
  'source',
  'extra',
  'from',
  'lifecycle',
] as const;
const CHUNK_SIZE = 100;
type Before = { timestamp: number; messageId: string };

function decodeFields(fields: Array<string | null>): StoredMessage | null {
  const [
    id,
    threadId,
    owner,
    catId,
    timestamp,
    timelineOrderAt,
    deletedAt,
    deliveryStatus,
    origin,
    source,
    extra,
    from,
    lifecycle,
  ] = fields;
  if (!id || (deletedAt && Number.parseInt(deletedAt, 10))) return null;
  const sourceField = parseConnectorSourceField(source ?? undefined);
  return {
    id,
    threadId: threadId || DEFAULT_THREAD_ID,
    userId: owner ?? 'unknown',
    catId: (catId || null) as CatId | null,
    timestamp: parseRedisNumber(timestamp ?? '0'),
    content: '',
    mentions: [],
    ...(timelineOrderAt !== null ? { timelineOrderAt: parseRedisNumber(timelineOrderAt) } : {}),
    ...(deliveryStatus ? { deliveryStatus: deliveryStatus as StoredMessage['deliveryStatus'] } : {}),
    ...(origin === 'stream' || origin === 'callback' || origin === 'briefing' ? { origin } : {}),
    ...(sourceField.kind === 'valid' ? { source: sourceField.source } : {}),
    ...(sourceField.kind === 'invalid' ? { sourceParseFailure: true as const } : {}),
    from: safeParseMessageFrom(from),
    lifecycle: safeParseLifecycleMetadata(lifecycle ?? undefined),
    extra: safeParseExtra(extra ?? undefined),
  };
}

function projectPosition(message: StoredMessage): ThreadReplyProjection {
  const result: ThreadReplyProjection = { id: message.id, catId: message.catId, timestamp: message.timestamp };
  if (message.timelineOrderAt !== undefined) result.timelineOrderAt = message.timelineOrderAt;
  if (message.extra) {
    result.extra = {};
    if (message.extra.stream) result.extra.stream = message.extra.stream;
    if (message.extra.isExplicitPost) result.extra.isExplicitPost = true;
  }
  return result;
}

function decodePipelineFields(value: unknown): Array<string | null> {
  if (
    !Array.isArray(value) ||
    value.length !== FIELDS.length ||
    value.some((field) => field !== null && typeof field !== 'string')
  ) {
    throw new Error('Reply projection hash fields unavailable');
  }
  return value as Array<string | null>;
}

async function readPositionBatch(
  redis: RedisClient,
  ids: string[],
  threadId: string,
  userId: string,
): Promise<ThreadReplyProjection[]> {
  if (ids.length === 0) return [];
  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.hmget(MessageKeys.detail(id), ...FIELDS);
  const rows = await pipeline.exec();
  if (!rows || rows.length !== ids.length) throw new Error('Reply projection hash batch incomplete');
  const isVisible = resolveThreadMessageVisibility(undefined, userId);
  return rows.flatMap(([error, value], index) => {
    if (error) throw error;
    const fields = decodePipelineFields(value);
    if (fields[0] !== ids[index]) return []; // Missing/pruned hashes cannot substitute another source.
    const message = decodeFields(fields);
    if (!message || message.threadId !== threadId || !isVisible(message)) return [];
    if (message.userId !== userId && !isSystemUserMessage(message)) return [];
    return [projectPosition(message)];
  });
}

async function readPositions(
  redis: RedisClient,
  ids: string[],
  threadId: string,
  userId: string,
): Promise<ThreadReplyProjection[]> {
  const result: ThreadReplyProjection[] = [];
  for (let offset = 0; offset < ids.length; offset += CHUNK_SIZE) {
    result.push(...(await readPositionBatch(redis, ids.slice(offset, offset + CHUNK_SIZE), threadId, userId)));
  }
  return result;
}

function selectPageIds(raw: string[], before?: Before): string[] {
  if (raw.length % 2 !== 0) throw new Error('Reply projection index returned incomplete scores');
  const ids: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const id = raw[i];
    const score = raw[i + 1];
    if (id === undefined || score === undefined) throw new Error('Reply projection index omitted member');
    if (before && parseRedisNumber(score) === before.timestamp && id >= before.messageId) continue;
    ids.push(id);
  }
  return ids;
}

/** A read-only scan of one existing thread index; no payload hashes, writes, or new persisted index. */
export async function readThreadReplyProjection(
  redis: RedisClient,
  threadId: string,
  userId: string,
  limit = 500,
  before?: Before,
): Promise<ThreadReplyProjection[]> {
  const target = Math.max(0, Math.min(500, Math.floor(limit)));
  // Match the existing reader's index snapshot; only metadata hydration is split.
  const indexWindow = Math.max(target, 50);
  const key = MessageKeys.thread(threadId);
  const result: ThreadReplyProjection[] = [];
  let offset = 0;
  while (result.length < target) {
    const raw = before
      ? await redis.zrevrangebyscore(key, String(before.timestamp), '-inf', 'WITHSCORES', 'LIMIT', offset, indexWindow)
      : await redis.zrevrange(key, offset, offset + indexWindow - 1, 'WITHSCORES');
    const ids = selectPageIds(raw, before);
    const positions = await readPositions(redis, ids, threadId, userId);
    result.push(...positions.slice(0, target - result.length));
    const scanned = raw.length / 2;
    if (scanned < indexWindow) break;
    offset += scanned;
  }
  return result.reverse();
}
