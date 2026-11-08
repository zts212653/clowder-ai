import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRedisClient } from '@cat-cafe/shared/utils';
import Database from 'better-sqlite3';
import { RedisMessageStore } from '../../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { RedisThreadStore } from '../../dist/domains/cats/services/stores/redis/RedisThreadStore.js';
import { ThreadKeys } from '../../dist/domains/cats/services/stores/redis-keys/thread-keys.js';
import { MessageSearchAnswerPublicationService } from '../../dist/domains/memory/MessageSearchAnswerPublicationService.js';
import { MessageSearchAnswerPublicationStore } from '../../dist/domains/memory/MessageSearchAnswerPublicationStore.js';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';
import { MESSAGE_SEARCH_ANSWER_SCHEMA } from '../../dist/domains/memory/message-search-answer-schema.js';
import { buildSearchableMessageContent } from '../../dist/domains/memory/message-search-content.js';
import { redisSelectedSourceReadFence } from '../../dist/domains/memory/message-selected-read-fence.js';
import { ownedRedisFixture } from './owned-redis-fixture.js';

// Public discovery owns a portless child; test:redis supplies its isolated TCP child.
const isolated = process.env.CAT_CAFE_REDIS_TEST_ISOLATED === '1';
const owned = isolated ? null : ownedRedisFixture('selected-source-fence');
const endpoint = isolated ? new URL(process.env.REDIS_URL) : null;
if (endpoint) {
  assert.equal(endpoint.hostname, '127.0.0.1');
  assert.ok(![6397, 6398, 6399, 6401].includes(Number(endpoint.port)));
}
export const producer = { kind: 'agent_key', id: 'selected-read-fence', catId: 'codex61-sol' };
export const human = { userId: 'owner', viewer: { type: 'user' }, publicReply: true };

export async function selectedSourceRedisFixture() {
  const redis = owned ? owned.client() : createRedisClient({ url: endpoint.href });
  const messages = new RedisMessageStore(redis, { ttlSeconds: 0 });
  const threads = new RedisThreadStore(redis, { ttlSeconds: 0 });
  const target = await threads.create('owner', 'card destination');
  const sourceThread = await threads.create('owner', 'selected source');
  const origin = await messages.append({
    userId: 'owner',
    threadId: sourceThread.id,
    from: { kind: 'agent', catId: 'gemini-argon' },
    content: '只有全部测试通过，才允许上线。',
    mentions: [],
    timestamp: 20,
  });
  const attachment = {
    v: 1,
    id: 'q',
    kind: 'quote',
    text: origin.content,
    comment: '我还没有批准。',
    source: { kind: 'message', threadId: sourceThread.id, messageId: origin.id },
  };
  const source = await messages.append({
    userId: 'owner',
    threadId: sourceThread.id,
    from: { kind: 'user', userId: 'owner' },
    content: '转引材料',
    mentions: [],
    timestamp: 30,
    contentBlocks: [
      { type: 'text', text: '转引材料' },
      { type: 'context_attachment', attachment },
    ],
  });
  await redis.hset(ThreadKeys.detail(sourceThread.id), 'createdBy', 'system');
  const db = new Database(':memory:');
  db.exec(MESSAGE_SEARCH_ANSWER_SCHEMA);
  const store = new MessageSearchAnswerPublicationStore(db);
  const search = new MessageSearchService({
    messageStore: messages,
    threadStore: threads,
    evidenceStore: {
      readMessagePassageState: () => ({ current: true, suppressThreadTitle: false }),
      searchMessagePassages: () => {
        throw new Error('selected cards must not retrieve');
      },
    },
    decisionIndex: { lookup: async () => ({ status: 'ready', revision: 'a'.repeat(40), facts: new Map() }) },
    selectedSourceReadFence: redisSelectedSourceReadFence(redis),
  });
  const create = () =>
    new MessageSearchAnswerPublicationService(new MessageSearchAnswerPublicationStore(db), search, messages, threads);
  const service = create();
  const request = {
    operationId: 'one-purpose',
    input: { query: '上线' },
    producer,
    principal: human,
    targetThreadId: target.id,
    selections: [
      {
        threadId: sourceThread.id,
        messageId: source.id,
        contentRevision: createHash('sha256').update(buildSearchableMessageContent(source)).digest('hex'),
        quote: '允许上线',
        reason: '原文含前提',
      },
    ],
  };
  const prepared = await service.prepare(request);
  assert.equal(prepared.status, 'prepared');
  async function publish() {
    const selection = { publicationRef: prepared.publicationRef };
    const block = await service.preparePost(selection, 'owner', producer, target.id);
    const message = await messages.append({
      from: { kind: 'agent', catId: producer.catId },
      userId: 'owner',
      threadId: target.id,
      content: 'Answer',
      mentions: [],
      timestamp: 100,
      origin: 'callback',
      extra: { isExplicitPost: true, rich: { v: 1, blocks: [block] } },
    });
    return { message, published: await service.publishPost(selection, message.id, producer, 'owner') };
  }
  return {
    redis,
    messages,
    threads,
    sourceThread,
    source,
    origin,
    store,
    search,
    service,
    create,
    request,
    prepared,
    publish,
    close: async () => {
      db.close();
      await redis.quit();
    },
  };
}
