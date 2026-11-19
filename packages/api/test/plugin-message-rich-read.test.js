/**
 * Plugin messages keep rich blocks as `rich_block` elements of `extra.pluginMessage`; every
 * store read derives `extra.rich` from them, so history, live emits and every other reader see
 * the same shape member messages have, while the plugin envelope stays the stored elements.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { AppendService } from '../dist/domains/messaging/append-service.js';
import { projectEnvelope } from '../dist/domains/messaging/envelope.js';
import { HandleService } from '../dist/domains/messaging/handles.js';
import { MessagingLedger } from '../dist/domains/messaging/ledger.js';
import { SendService } from '../dist/domains/messaging/send-service.js';
import {
  MemoryAppendLock,
  MemoryCursorStore,
  MemoryEventLogStore,
  MemoryHandleStore,
  MemoryLedgerStore,
} from '../dist/domains/messaging/stores/memory.js';
import { messagesRoutes } from '../dist/routes/messages.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const CTX = { pluginInstanceId: 'inst-a' };
const SOURCE = { connector: 'feedback', label: 'Feedback', icon: 'message' };
const CARD = {
  id: 'card-1',
  kind: 'card',
  v: 1,
  title: 'Feedback received',
  bodyMarkdown: 'Thanks',
  meta: { kind: 'feedback', ref: 'fb-1' },
};
const INVALID = { id: 'bad-1', kind: 'card', v: 1 };
const CHECKLIST = { id: 'list-1', kind: 'checklist', v: 1, items: [{ id: 'i1', text: 'triage' }] };

async function check(messageStore) {
  const handles = new HandleService(new MemoryHandleStore(), new MemoryCursorStore());
  const ledger = new MessagingLedger(new MemoryLedgerStore());
  const events = new MemoryEventLogStore();
  const broadcasts = [];
  const send = new SendService({
    messageStore,
    handles,
    ledger,
    events,
    isKnownCatId: () => false,
    ingressWake: {
      invokeTrigger: { trigger: async () => 'dispatched' },
      socketManager: { broadcastToRoom: (...args) => broadcasts.push(args) },
    },
  });
  const append = new AppendService({ messageStore, handles, ledger, events, appendLock: new MemoryAppendLock() });
  const { handleId } = await handles.issueThreadHandle({
    pluginInstanceId: 'inst-a',
    threadId: 'thread-1',
    userId: 'owner',
    scope: { canSend: true, canSubscribe: true },
  });
  const elements = [
    { elementId: 'el-text', kind: 'text', payload: { text: 'new feedback' } },
    { elementId: 'el-card', kind: 'rich_block', payload: CARD },
    { elementId: 'el-bad', kind: 'rich_block', payload: INVALID },
  ];
  const receipt = await send.send(
    CTX,
    {
      address: { kind: 'thread_handle', handle: handleId },
      idempotencyKey: 'send-1',
      payload: { provenance: { epistemicStatus: 'observation' }, elements },
    },
    { source: SOURCE },
  );

  const stored = await messageStore.getById(receipt.messageId);
  assert.deepEqual(stored.extra.rich, { v: 1, blocks: [CARD] }, 'valid blocks derived in element order');
  assert.deepEqual(stored.extra.pluginMessage.elements, elements, 'the plugin payload stays the single source');
  assert.deepEqual(projectEnvelope(stored).payload.elements, elements, 'plugin envelope is unchanged');

  assert.equal(broadcasts.length, 1);
  const [room, event, live] = broadcasts[0];
  assert.equal(room, 'thread:thread-1');
  assert.equal(event, 'connector_message');
  assert.deepEqual(live.message.extra, { rich: { v: 1, blocks: [CARD] } }, 'live emit carries the derived blocks');

  const member = await messageStore.append({
    from: { kind: 'agent', catId: 'opus' },
    threadId: 'thread-1',
    userId: 'owner',
    content: 'member card',
    mentions: [],
    timestamp: Date.now() + 1,
    extra: { rich: { v: 1, blocks: [CHECKLIST] } },
  });

  const app = Fastify();
  try {
    await app.register(messagesRoutes, { messageStore, router: {}, registry: {}, socketManager: {} });
    const response = await app.inject({
      url: '/api/messages?threadId=thread-1',
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(response.statusCode, 200, response.body);
    const rows = response.json().messages;
    assert.deepEqual(rows.find((row) => row.id === receipt.messageId).extra.rich.blocks, [CARD]);
    assert.deepEqual(rows.find((row) => row.id === member.id).extra.rich.blocks, [CHECKLIST], 'member unchanged');
    assert.equal(rows.find((row) => row.id === receipt.messageId).extra.pluginMessage, undefined);
  } finally {
    await app.close();
  }

  await append.appendElements(CTX, {
    handle: receipt.messageHandle,
    operationId: 'op-1',
    elements: [{ elementId: 'el-list', kind: 'rich_block', payload: CHECKLIST }],
  });
  const appended = await messageStore.getById(receipt.messageId);
  assert.deepEqual(appended.extra.rich.blocks, [CARD, CHECKLIST], 'appended blocks join the derived list');
  assert.deepEqual(
    projectEnvelope(appended).payload.elements.map((element) => element.elementId),
    ['el-text', 'el-card', 'el-bad', 'el-list'],
  );

  await messageStore.updateExtra(receipt.messageId, { rich: { v: 1, blocks: [CHECKLIST] }, isExplicitPost: true });
  const patched = await messageStore.getById(receipt.messageId);
  assert.equal(patched.extra.isExplicitPost, true);
  assert.deepEqual(patched.extra.rich.blocks, [CARD, CHECKLIST], 'the elements decide for a plugin message');
  return receipt.messageId;
}

test('Memory: plugin rich blocks are read as extra.rich everywhere', () => check(new MessageStore()));

test(
  'Redis: plugin rich blocks are read as extra.rich everywhere',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'plugin message rich read');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const { RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    const { MessageKeys } = await import('../dist/domains/cats/services/stores/redis-keys/message-keys.js');
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `plugin-rich-${randomUUID()}:` });
    try {
      const store = new RedisMessageStore(redis, { ttlSeconds: 0 });
      const messageId = await check(store);
      const [extra, pluginMessage] = await redis.hmget(MessageKeys.detail(messageId), 'extra', 'pluginMessage');
      assert.ok(JSON.parse(pluginMessage).elements.some((element) => element.payload.id === 'card-1'));
      assert.equal(JSON.parse(extra || '{}').rich, undefined, 'the derived blocks are never persisted');
    } finally {
      await redis.quit();
    }
  },
);
