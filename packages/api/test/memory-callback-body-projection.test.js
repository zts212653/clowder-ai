import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { coCreatorDisplay } from '@cat-cafe/shared';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';
import { getCoCreatorConfig } from '../dist/config/cat-config-loader.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { DeliveryCursorStore } from '../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { projectQueuedCallbackMessageBody } from '../dist/routes/callback-message-body.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';
import { createCallbackContextFixture } from './helpers/callback-context-fixture.js';
import { adaptMessageStore } from './helpers/message-from-fixtures.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/memory-runtime-quote.json', import.meta.url), 'utf8'));

async function setup(overrides = {}) {
  const messageStore = adaptMessageStore(new MessageStore());
  const threadStore = new ThreadStore();
  const registry = new InvocationRegistry();
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore,
    threadStore,
    socketManager: { broadcastAgentMessage() {}, emitToUser() {}, broadcastToRoom() {} },
    ...overrides,
  });
  const { invocationId, callbackToken } = await registry.create('default-user', 'codex61-sol');
  const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };
  return { app, messageStore, headers, invocationId };
}

test('queued transcript timestamps retain durable source time across repeated reads', async (t) => {
  const f = await createCallbackContextFixture(t);
  const timestamp = 1350;
  const admitted = await f.enqueue('queued user notice', {}, { timestamp });
  for (let i = 0; i < 2; i++) {
    const result = await f.read();
    assert.equal(result.statusCode, 200, result.body);
    const projected = result.json().messages.find((m) => m.id === admitted.message.id);
    assert.equal(projected.timestamp, timestamp, 'reading must not manufacture an event time');
  }
  assert.equal(f.messages.getById(admitted.message.id).lifecycle.dispatchRefs.length, 1);
});

test('queued runtime quote retains the complete body in context and exact drill', async (t) => {
  const f = await createCallbackContextFixture(t);
  const admitted = await f.enqueue('', {}, { timestamp: fixture.timestamp, contentBlocks: fixture.contentBlocks });
  const context = await f.read();
  const drill = await f.app.inject({
    url: `/api/callbacks/get-message?messageId=${admitted.message.id}&mode=full`,
    headers: { 'x-invocation-id': f.auth.invocationId, 'x-callback-token': f.auth.callbackToken },
  });
  assert.equal(context.statusCode, 200, context.body);
  assert.equal(drill.statusCode, 200, drill.body);
  const projected = context.json().messages.find((m) => m.id === admitted.message.id);
  assert.equal(projected.content, drill.json().message.content);
  assert.deepEqual(projected.contentBlocks, fixture.contentBlocks);
  assert.match(projected.content, /可以啊 你喊他继续啊/);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, admitted.entry.id)).targets, ['codex']);
});

for (const sourceCase of ['missing', 'foreign', 'unavailable']) {
  test(`queued body projection withholds ${sourceCase} persisted source without a text fallback`, async () => {
    const result = await projectQueuedCallbackMessageBody(
      { entryId: 'owned-entry', messageId: 'source-id', content: 'queue text alone is incomplete' },
      {
        getById: async () => {
          if (sourceCase === 'unavailable') throw new Error('owned store unavailable');
          return sourceCase === 'missing'
            ? null
            : {
                id: 'source-id',
                threadId: 'owned-thread',
                userId: 'foreign-owner',
                from: { kind: 'user', userId: 'foreign-owner' },
                content: 'private content',
                contentBlocks: fixture.contentBlocks,
              };
        },
      },
      { threadId: 'owned-thread', userId: 'owner', catId: 'opus', viewer: { type: 'cat', catId: 'opus' } },
    );
    assert.equal(result.content, '');
    assert.equal(result.contentLength, 0);
    assert.equal(result.contentBlocks, undefined);
    assert.equal(
      result.sourceUnavailableReason,
      sourceCase === 'unavailable' ? 'queued_body_source_unavailable' : 'queued_body_source_changed',
    );
  });
}

test('runtime quote source retains the paired owner comment and original provenance in both full readers', async () => {
  const { app, messageStore, headers } = await setup();
  try {
    const message = messageStore.append({
      userId: 'default-user',
      catId: null,
      content: '',
      contentBlocks: fixture.contentBlocks,
      mentions: [],
      timestamp: fixture.timestamp,
    });
    const context = await app.inject({ url: '/api/callbacks/thread-context?responseMode=full', headers });
    const drill = await app.inject({ url: `/api/callbacks/get-message?messageId=${message.id}&mode=full`, headers });
    assert.equal(context.statusCode, 200, context.body);
    assert.equal(drill.statusCode, 200, drill.body);
    for (const projected of [context.json().messages[0], drill.json().message]) {
      assert.deepEqual(projected.contentBlocks, fixture.contentBlocks);
      assert.match(projected.content, /可以啊 你喊他继续啊/);
      assert.equal(projected.contentLength, projected.content.length);
      assert.equal(projected.truncated, false);
      const coCreator = getCoCreatorConfig();
      assert.equal(projected.speaker, coCreator.nickname ?? coCreatorDisplay(coCreator).nickname);
    }
    assert.equal(context.json().messages[0].content, drill.json().message.content);
  } finally {
    await app.close();
  }
});

for (const outerComment of ['', '请按这段批注继续']) {
  test(`pending mention anchor/full retains the runtime quote with ${outerComment ? 'an outer comment' : 'empty text'}`, async () => {
    const { app, messageStore, headers } = await setup();
    try {
      const message = messageStore.append({
        userId: 'default-user',
        catId: null,
        content: outerComment,
        contentBlocks: fixture.contentBlocks,
        mentions: ['codex61-sol'],
        timestamp: fixture.timestamp,
      });
      const full = await app.inject({ url: '/api/callbacks/pending-mentions?responseMode=full', headers });
      const anchor = await app.inject({ url: '/api/callbacks/pending-mentions', headers });
      const drill = await app.inject({ url: `/api/callbacks/get-message?messageId=${message.id}&mode=full`, headers });
      assert.equal(full.statusCode, 200, full.body);
      assert.equal(anchor.statusCode, 200, anchor.body);
      assert.equal(drill.statusCode, 200, drill.body);
      const complete = full.json().mentions[0];
      const excerpt = anchor.json().mentions[0];
      assert.equal(complete.id, message.id);
      assert.deepEqual(complete.contentBlocks, fixture.contentBlocks);
      assert.match(complete.message, /可以啊 你喊他继续啊/);
      assert.equal(complete.message, drill.json().message.content);
      assert.equal(complete.contentLength, complete.message.length);
      assert.equal(complete.requiresDrill, false);
      const coCreator = getCoCreatorConfig();
      assert.equal(complete.from, coCreator.nickname ?? coCreatorDisplay(coCreator).nickname);
      if (outerComment) assert.ok(complete.message.startsWith(outerComment));
      assert.ok(excerpt.message.length > 0);
      assert.equal(excerpt.contentLength, complete.contentLength);
      assert.equal(excerpt.requiresDrill, excerpt.message !== complete.message);
      assert.equal(excerpt.drillDown.args.messageId, message.id);
      assert.equal(excerpt.contentBlocks, undefined, 'anchor remains bounded; full drill retains attachments');
    } finally {
      await app.close();
    }
  });
}

test('oversized quote remains unseen until its full drill is actually returned', async () => {
  const deliveryCursorStore = new DeliveryCursorStore();
  const { app, messageStore, headers } = await setup({ deliveryCursorStore });
  try {
    const attachment = structuredClone(fixture.contentBlocks[0].attachment);
    attachment.text = 'x'.repeat(15000);
    const message = messageStore.append({
      userId: 'default-user',
      catId: null,
      content: '',
      contentBlocks: [{ type: 'context_attachment', attachment }],
      mentions: [],
      timestamp: 1,
    });
    const response = await app.inject({
      url: '/api/callbacks/thread-context?readIntent=unread&responseMode=full',
      headers,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(Buffer.byteLength(response.body) <= 24000);
    const projected = response.json().messages[0];
    assert.equal(projected.id, message.id);
    assert.equal(projected.oversized, true);
    assert.equal(projected.truncated, true);
    assert.ok(projected.contentLength > 15000);
    assert.equal(await deliveryCursorStore.getSeenCursor('default-user', 'codex61-sol', 'default'), undefined);
    const drill = await app.inject({ url: `/api/callbacks/get-message?messageId=${message.id}&mode=full`, headers });
    assert.equal(drill.statusCode, 200, drill.body);
    assert.equal(drill.json().message.contentBlocks[0].attachment.text, attachment.text);
  } finally {
    await app.close();
  }
});

test('full-body budget includes structured attachments and paginates without dropping any source', async () => {
  const { app, messageStore, headers } = await setup();
  try {
    const expected = [];
    for (let i = 0; i < 8; i++) {
      const attachment = structuredClone(fixture.contentBlocks[0].attachment);
      attachment.text = `quote-${i}-` + 'x'.repeat(1800);
      expected.push(
        messageStore.append({
          userId: 'default-user',
          catId: null,
          content: 'outer comment',
          contentBlocks: [
            { type: 'context_attachment', attachment },
            { type: 'file', url: '/uploads/notes.txt', fileName: 'notes.txt', mimeType: 'text/plain', fileSize: 30 },
          ],
          mentions: [],
          timestamp: i + 1,
        }).id,
      );
    }
    const actual = [];
    let cursor;
    do {
      const params = new URLSearchParams({ responseMode: 'full', limit: '20' });
      if (cursor) params.set('cursor', cursor);
      const response = await app.inject({ url: `/api/callbacks/thread-context?${params}`, headers });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(Buffer.byteLength(response.body) <= 24000);
      const body = response.json();
      for (const msg of body.messages) {
        assert.equal(msg.contentBlocks.length, 2);
        assert.match(msg.content, /outer comment/);
        assert.ok(msg.contentLength > 1800);
        assert.equal(msg.truncated, false);
        actual.push(msg.id);
      }
      cursor = body.nextCursor;
    } while (cursor);
    assert.deepEqual(actual, expected);
  } finally {
    await app.close();
  }
});
