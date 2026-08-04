import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  AppendMessageInput,
  StoredMessage,
  ThreadFrontierAppendResult,
  ThreadObservedAppendResult,
} from '../ports/MessageStore.js';
import { assertValidAppendMessageInput, DEFAULT_THREAD_ID, generateSortableId } from '../ports/MessageStore.js';
import { assertQueueCustodyMessageBinding } from '../ports/queued-message-custody.js';
import { MessageKeys } from '../redis-keys/message-keys.js';
import { serializeExtra } from './redis-message-parsers.js';

const APPEND_IF_THREAD_FRONTIER_LUA = `
if ARGV[4] == '1' then
  local existing = redis.call('GET', KEYS[5])
  if existing then return {'existing', existing} end
end
local latestRows = redis.call('ZREVRANGE', KEYS[1], 0, 0)
local actual = latestRows[1] or ''
local expected = ARGV[1] == '__NULL__' and '' or ARGV[1]
if actual ~= expected then return {'frontier', actual} end
if ARGV[4] == '1' then redis.call('SET', KEYS[5], ARGV[2]) end
local fields = cjson.decode(ARGV[6])
for field, value in pairs(fields) do redis.call('HSET', KEYS[2], field, value) end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[2])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[2])
redis.call('ZADD', KEYS[4], ARGV[3], ARGV[2])
for index = 6, #KEYS do redis.call('ZADD', KEYS[index], ARGV[3], ARGV[2]) end
local ttl = tonumber(ARGV[5])
if ttl and ttl > 0 then
  redis.call('EXPIRE', KEYS[2], ttl)
  redis.call('EXPIRE', KEYS[1], ttl)
  redis.call('EXPIRE', KEYS[3], ttl)
  redis.call('EXPIRE', KEYS[4], ttl)
  if ARGV[4] == '1' then redis.call('EXPIRE', KEYS[5], ttl) end
  for index = 6, #KEYS do redis.call('EXPIRE', KEYS[index], ttl) end
end
return {'committed', ARGV[2]}
`;

const APPEND_AND_OBSERVE_PRIOR_FRONTIER_LUA = `
if ARGV[4] == '1' then
  local existing = redis.call('GET', KEYS[5])
  if existing then return {'existing', existing, ''} end
end
local latestRows = redis.call('ZREVRANGE', KEYS[1], 0, 0)
local prior = latestRows[1] or ''
if ARGV[4] == '1' then redis.call('SET', KEYS[5], ARGV[1]) end
local fields = cjson.decode(ARGV[6])
local extra = {}
if fields.extra and fields.extra ~= '' then extra = cjson.decode(fields.extra) end
extra.freshness = {
  kind = 'scan_pending',
  priorFrontierMessageId = prior ~= '' and prior or cjson.null
}
fields.extra = cjson.encode(extra)
for field, value in pairs(fields) do redis.call('HSET', KEYS[2], field, value) end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[2], ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[2], ARGV[1])
for index = 6, #KEYS do redis.call('ZADD', KEYS[index], ARGV[2], ARGV[1]) end
local ttl = tonumber(ARGV[5])
if ttl and ttl > 0 then
  redis.call('EXPIRE', KEYS[2], ttl)
  redis.call('EXPIRE', KEYS[1], ttl)
  redis.call('EXPIRE', KEYS[3], ttl)
  redis.call('EXPIRE', KEYS[4], ttl)
  if ARGV[4] == '1' then redis.call('EXPIRE', KEYS[5], ttl) end
  for index = 6, #KEYS do redis.call('EXPIRE', KEYS[index], ttl) end
end
return {'committed', ARGV[1], prior}
`;

const DELETE_IDEMPOTENCY_POINTER_IF_VALUE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export async function appendMessageIfThreadFrontier(input: {
  redis: RedisClient;
  message: AppendMessageInput;
  expectedLatestMessageId: string | null;
  ttlSeconds: number | null;
  loadById: (messageId: string) => Promise<StoredMessage | null>;
  onAppend?: (message: StoredMessage) => void | Promise<void>;
}): Promise<ThreadFrontierAppendResult> {
  const { redis, message, expectedLatestMessageId, ttlSeconds, loadById, onAppend } = input;
  assertValidAppendMessageInput(message);
  assertQueueCustodyMessageBinding(message);
  const threadId = message.threadId ?? DEFAULT_THREAD_ID;
  const id = generateSortableId(message.timestamp);
  // F288: split pluginMessage from host extra — stored as independent hash field
  const { pluginMessage, ...hostExtra } = message.extra ?? {};
  const hasHostExtra = Object.keys(hostExtra).length > 0;
  const hashFields: Record<string, string> = {
    id,
    threadId,
    userId: message.userId,
    catId: message.catId ?? '',
    content: message.content,
    contentBlocks: message.contentBlocks ? JSON.stringify(message.contentBlocks) : '',
    toolEvents: message.toolEvents ? JSON.stringify(message.toolEvents) : '',
    metadata: message.metadata ? JSON.stringify(message.metadata) : '',
    extra: hasHostExtra ? serializeExtra(hostExtra) : '',
    ...(pluginMessage ? { pluginMessage: JSON.stringify(pluginMessage) } : {}),
    mentions: JSON.stringify(message.mentions),
    timestamp: String(message.timestamp),
    ...(message.thinking ? { thinking: message.thinking } : {}),
    ...(message.origin ? { origin: message.origin } : {}),
    ...(message.visibility ? { visibility: message.visibility } : {}),
    ...(message.whisperTo ? { whisperTo: JSON.stringify(message.whisperTo) } : {}),
    ...(message.source ? { source: JSON.stringify(message.source) } : {}),
    ...(message.mentionsUser ? { mentionsUser: '1' } : {}),
    ...(message.deliveryStatus ? { deliveryStatus: message.deliveryStatus } : {}),
    ...(message.queueCustody
      ? {
          queueCustody: JSON.stringify(message.queueCustody),
          queueCustodyRevision: String(message.queueCustody.revision),
        }
      : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
  };
  const idempotencyRedisKey = message.idempotencyKey
    ? MessageKeys.idempotency(message.userId, threadId, message.idempotencyKey)
    : `msg:conditional:no-idempotency:${id}`;
  const keys = [
    MessageKeys.thread(threadId),
    MessageKeys.detail(id),
    MessageKeys.TIMELINE,
    MessageKeys.user(message.userId),
    idempotencyRedisKey,
    ...message.mentions.map((catId) => MessageKeys.mentions(catId)),
  ];
  const [kind, value] = (await redis.eval(
    APPEND_IF_THREAD_FRONTIER_LUA,
    keys.length,
    ...keys,
    expectedLatestMessageId ?? '__NULL__',
    id,
    String(message.timestamp),
    message.idempotencyKey ? '1' : '0',
    String(ttlSeconds ?? 0),
    JSON.stringify(hashFields),
  )) as [string, string];
  if (kind === 'frontier') return { kind: 'frontier_advanced', actualLatestMessageId: value || null };
  const stored = await loadById(value);
  if (!stored) throw new Error(`conditional message append lost stored message: ${value}`);
  if (kind === 'committed' && onAppend) {
    try {
      void Promise.resolve(onAppend(stored)).catch(() => {});
    } catch {
      // best-effort thread-index projection
    }
  }
  return { kind: 'committed', message: stored };
}

function readStoredPriorFrontier(message: StoredMessage): string | null {
  const freshness = message.extra?.freshness;
  return freshness && 'priorFrontierMessageId' in freshness ? freshness.priorFrontierMessageId : null;
}

/**
 * ADR-042 D5: append is unconditional. The Lua step records the raw thread
 * frontier that existed immediately before the new row and stamps that exact
 * boundary into message metadata. Idempotent retries return the first row and
 * therefore the first boundary.
 */
export async function appendMessageAndObservePriorFrontier(input: {
  redis: RedisClient;
  message: AppendMessageInput;
  ttlSeconds: number | null;
  loadById: (messageId: string) => Promise<StoredMessage | null>;
  onAppend?: (message: StoredMessage) => void | Promise<void>;
}): Promise<ThreadObservedAppendResult> {
  const { redis, message, ttlSeconds, loadById, onAppend } = input;
  assertValidAppendMessageInput(message);
  assertQueueCustodyMessageBinding(message);
  const threadId = message.threadId ?? DEFAULT_THREAD_ID;
  const id = generateSortableId(message.timestamp);
  // F288: split pluginMessage from host extra — stored as independent hash field
  const { pluginMessage: pm2, ...hostExtra2 } = message.extra ?? {};
  const hasHostExtra2 = Object.keys(hostExtra2).length > 0;
  const hashFields: Record<string, string> = {
    id,
    threadId,
    userId: message.userId,
    catId: message.catId ?? '',
    content: message.content,
    contentBlocks: message.contentBlocks ? JSON.stringify(message.contentBlocks) : '',
    toolEvents: message.toolEvents ? JSON.stringify(message.toolEvents) : '',
    metadata: message.metadata ? JSON.stringify(message.metadata) : '',
    extra: hasHostExtra2 ? serializeExtra(hostExtra2) : '',
    ...(pm2 ? { pluginMessage: JSON.stringify(pm2) } : {}),
    mentions: JSON.stringify(message.mentions),
    timestamp: String(message.timestamp),
    ...(message.thinking ? { thinking: message.thinking } : {}),
    ...(message.origin ? { origin: message.origin } : {}),
    ...(message.visibility ? { visibility: message.visibility } : {}),
    ...(message.whisperTo ? { whisperTo: JSON.stringify(message.whisperTo) } : {}),
    ...(message.source ? { source: JSON.stringify(message.source) } : {}),
    ...(message.mentionsUser ? { mentionsUser: '1' } : {}),
    ...(message.deliveryStatus ? { deliveryStatus: message.deliveryStatus } : {}),
    ...(message.queueCustody
      ? {
          queueCustody: JSON.stringify(message.queueCustody),
          queueCustodyRevision: String(message.queueCustody.revision),
        }
      : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
  };
  const idempotencyRedisKey = message.idempotencyKey
    ? MessageKeys.idempotency(message.userId, threadId, message.idempotencyKey)
    : `msg:observed:no-idempotency:${id}`;
  const keys = [
    MessageKeys.thread(threadId),
    MessageKeys.detail(id),
    MessageKeys.TIMELINE,
    MessageKeys.user(message.userId),
    idempotencyRedisKey,
    ...message.mentions.map((catId) => MessageKeys.mentions(catId)),
  ];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [kind, value, prior] = (await redis.eval(
      APPEND_AND_OBSERVE_PRIOR_FRONTIER_LUA,
      keys.length,
      ...keys,
      id,
      String(message.timestamp),
      threadId,
      message.idempotencyKey ? '1' : '0',
      String(ttlSeconds ?? 0),
      JSON.stringify(hashFields),
    )) as [string, string, string];
    const stored = await loadById(value);
    if (stored) {
      if (kind === 'committed' && onAppend) {
        try {
          void Promise.resolve(onAppend(stored)).catch(() => {});
        } catch {
          // best-effort thread-index projection
        }
      }
      return {
        kind: 'committed',
        message: stored,
        priorFrontierMessageId: kind === 'existing' ? readStoredPriorFrontier(stored) : prior || null,
        idempotent: kind === 'existing',
      };
    }
    if (kind !== 'existing' || !message.idempotencyKey) {
      throw new Error(`observed message append lost stored message: ${value}`);
    }
    await redis.eval(DELETE_IDEMPOTENCY_POINTER_IF_VALUE_LUA, 1, idempotencyRedisKey, value);
  }
  throw new Error('observed message append idempotency recovery exhausted');
}
