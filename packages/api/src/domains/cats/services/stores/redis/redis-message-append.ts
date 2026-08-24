import type { RedisClient } from '@cat-cafe/shared/utils';
import { normalizeJsonUnicode } from '../../../../../utils/json-unicode.js';
import type { AppendMessageInput, MessageAppendListener, StoredMessage } from '../ports/MessageStore.js';
import { assertValidAppendMessageInput, DEFAULT_THREAD_ID, generateSortableId } from '../ports/MessageStore.js';
import { assertQueueCustodyMessageBinding } from '../ports/queued-message-custody.js';
import { MessageKeys } from '../redis-keys/message-keys.js';
import { serializeExtra } from './redis-message-parsers.js';

const APPEND_MESSAGE_LUA = `
redis.replicate_commands()

local hash = KEYS[1]
local timeline = KEYS[2]
local user = KEYS[3]
local thread = KEYS[4]
local idempotency = KEYS[5]
local messageId = ARGV[1]
local fields = cjson.decode(ARGV[2])
local score = ARGV[3]
local hasIdempotency = ARGV[4] == '1'
local ttl = tonumber(ARGV[5])
local detailKeyPrefix = ARGV[6]

if hasIdempotency then
  local existingId = redis.call('GET', idempotency)
  if existingId and redis.call('EXISTS', detailKeyPrefix .. existingId) == 1 then
    return {'existing', existingId}
  end
end

for field, value in pairs(fields) do
  redis.call('HSET', hash, field, value)
end
redis.call('ZADD', timeline, score, messageId)
redis.call('ZADD', user, score, messageId)
redis.call('ZADD', thread, score, messageId)
for index = 6, #KEYS do
  redis.call('ZADD', KEYS[index], score, messageId)
end

if hasIdempotency then
  redis.call('SET', idempotency, messageId)
end

if ttl and ttl > 0 then
  redis.call('EXPIRE', hash, ttl)
  redis.call('EXPIRE', timeline, ttl)
  redis.call('EXPIRE', user, ttl)
  redis.call('EXPIRE', thread, ttl)
  if hasIdempotency then
    redis.call('EXPIRE', idempotency, ttl)
  end
  for index = 6, #KEYS do
    redis.call('EXPIRE', KEYS[index], ttl)
  end

  local redisTime = redis.call('TIME')
  local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
  local cutoff = nowMs - ttl * 1000
  redis.call('ZREMRANGEBYSCORE', timeline, '-inf', cutoff)
  redis.call('ZREMRANGEBYSCORE', user, '-inf', cutoff)
  redis.call('ZREMRANGEBYSCORE', thread, '-inf', cutoff)
  for index = 6, #KEYS do
    redis.call('ZREMRANGEBYSCORE', KEYS[index], '-inf', cutoff)
  end
end

return {'committed', messageId}
`;

function serializeMessage(message: AppendMessageInput, id: string, threadId: string): Record<string, string> {
  // F288: split pluginMessage from host extra — stored as independent hash field
  const { pluginMessage, ...hostExtra } = message.extra ?? {};
  const hasHostExtra = Object.keys(hostExtra).length > 0;
  return {
    id,
    threadId,
    userId: message.userId,
    catId: message.catId ?? '',
    content: message.content,
    mentions: JSON.stringify(message.mentions),
    timestamp: String(message.timestamp),
    ...(message.contentBlocks !== undefined ? { contentBlocks: JSON.stringify(message.contentBlocks) } : {}),
    ...(message.toolEvents !== undefined ? { toolEvents: JSON.stringify(message.toolEvents) } : {}),
    ...(message.metadata ? { metadata: JSON.stringify(message.metadata) } : {}),
    ...(hasHostExtra ? { extra: serializeExtra(hostExtra) } : {}),
    ...(pluginMessage ? { pluginMessage: JSON.stringify(pluginMessage) } : {}),
    ...(message.thinking ? { thinking: message.thinking } : {}),
    ...(message.origin ? { origin: message.origin } : {}),
    ...(message.visibility ? { visibility: message.visibility } : {}),
    ...(message.whisperTo !== undefined ? { whisperTo: JSON.stringify(message.whisperTo) } : {}),
    ...(message.source ? { source: JSON.stringify(message.source) } : {}),
    ...(message.mentionsUser ? { mentionsUser: '1' } : {}),
    ...(message.deliveryStatus ? { deliveryStatus: message.deliveryStatus } : {}),
    ...(message.queueCustody
      ? {
          queueCustody: JSON.stringify(message.queueCustody),
          queueCustodyRevision: String(message.queueCustody.revision),
        }
      : {}),
    ...(message.queueCustodyAdmission ? { queueCustodyAdmission: JSON.stringify(message.queueCustodyAdmission) } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
  };
}

export async function appendMessage(input: {
  redis: RedisClient;
  message: AppendMessageInput;
  ttlSeconds: number | null;
  loadById: (messageId: string) => Promise<StoredMessage | null>;
  onAppend?: MessageAppendListener;
}): Promise<StoredMessage> {
  const { redis, ttlSeconds, loadById, onAppend } = input;
  const message = normalizeJsonUnicode(input.message);
  assertValidAppendMessageInput(message);
  assertQueueCustodyMessageBinding(message);

  const threadId = message.threadId ?? DEFAULT_THREAD_ID;
  const id = generateSortableId(message.timestamp);
  const idempotencyKey = message.idempotencyKey
    ? MessageKeys.idempotency(message.userId, threadId, message.idempotencyKey)
    : `msg:append:no-idempotency:${id}`;
  const keys = [
    MessageKeys.detail(id),
    MessageKeys.TIMELINE,
    MessageKeys.user(message.userId),
    MessageKeys.thread(threadId),
    idempotencyKey,
    ...message.mentions.map((catId) => MessageKeys.mentions(catId)),
  ];
  const keyPrefix = (redis.options as { keyPrefix?: string }).keyPrefix ?? '';
  const [kind, returnedId] = (await redis.eval(
    APPEND_MESSAGE_LUA,
    keys.length,
    ...keys,
    id,
    JSON.stringify(serializeMessage(message, id, threadId)),
    String(message.timestamp),
    message.idempotencyKey ? '1' : '0',
    String(ttlSeconds ?? 0),
    `${keyPrefix}${MessageKeys.detail('')}`,
  )) as ['committed' | 'existing', string];

  const stored = await loadById(returnedId);
  if (!stored) {
    if (kind === 'existing') {
      throw new Error(`Idempotency winner ${returnedId} for key ${message.idempotencyKey} vanished before hydration`);
    }
    throw new Error(`message append lost stored message: ${returnedId}`);
  }

  if (kind === 'committed' && onAppend) {
    try {
      void Promise.resolve(onAppend(stored)).catch(() => {});
    } catch {
      // best-effort thread-index projection
    }
  }
  return stored;
}
