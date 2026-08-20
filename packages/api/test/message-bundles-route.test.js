import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';

const { messageBundleRoutes } = await import('../dist/routes/message-bundles.js');
const { digestMessageBundleQuoteProjection } = await import(
  '../dist/domains/cats/services/context/MessageSelectionResolver.js'
);

function targetMessage(overrides = {}) {
  return {
    id: 'bundle-1',
    threadId: 'target-thread',
    userId: 'user-1',
    catId: null,
    content: '转发了 1 条消息 · 来自「Source Thread」',
    mentions: ['opus'],
    timestamp: 200,
    extra: {
      messageBundle: {
        v: 1,
        sourceThreadId: 'source-thread',
        note: 'bundle-level reason',
        items: [{ kind: 'message', messageId: 'source-1' }],
      },
    },
    ...overrides,
  };
}

function sourceMessage(overrides = {}) {
  return {
    id: 'source-1',
    threadId: 'source-thread',
    userId: 'user-1',
    catId: 'opus',
    content: 'current source body',
    mentions: [],
    timestamp: 100,
    ...overrides,
  };
}

describe('GET /api/message-bundles/:messageId', () => {
  let app;
  let messages;
  let deps;

  beforeEach(async () => {
    messages = new Map([
      ['bundle-1', targetMessage()],
      ['source-1', sourceMessage()],
    ]);
    deps = {
      messageStore: {
        getById: mock.fn(async (id) => messages.get(id) ?? null),
        // Whole-message hydration resolves the canonical bubble group, so the store must expose
        // the same timeline the browser projected from.
        getByThreadAfter: mock.fn(async (threadId) =>
          [...messages.values()].filter((message) => message.threadId === threadId),
        ),
      },
      threadStore: {
        get: mock.fn(async (id) => ({
          id,
          title: id === 'source-thread' ? 'Source Thread' : 'Target Thread',
          createdBy: 'user-1',
        })),
      },
    };
    app = Fastify();
    await app.register(messageBundleRoutes, deps);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('requires strict user identity', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/message-bundles/bundle-1' });
    assert.equal(response.statusCode, 401);
    assert.equal(deps.messageStore.getById.mock.calls.length, 0);
  });

  it('hydrates current source truth with Bundle identity, source, author, and exact message ref', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/message-bundles/bundle-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(JSON.parse(response.body), {
      messageBundleId: 'bundle-1',
      targetThreadId: 'target-thread',
      createdBy: 'user-1',
      createdAt: 200,
      sourceThread: { id: 'source-thread', title: 'Source Thread' },
      note: 'bundle-level reason',
      items: [
        {
          status: 'available',
          kind: 'message',
          messageId: 'source-1',
          sourceThreadId: 'source-thread',
          author: { kind: 'cat', catId: 'opus' },
          timestamp: 100,
          readableContent: 'current source body',
        },
      ],
    });
  });

  it('rejects a foreign target Bundle before resolving any source refs', async () => {
    messages.set('bundle-1', targetMessage({ userId: 'another-user' }));
    const response = await app.inject({
      method: 'GET',
      url: '/api/message-bundles/bundle-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(response.statusCode, 403);
    assert.deepEqual(
      deps.messageStore.getById.mock.calls.map((call) => call.arguments[0]),
      ['bundle-1'],
    );
  });

  it('does not hydrate a recalled target carrier', async () => {
    messages.set(
      'bundle-1',
      targetMessage({
        deliveryStatus: 'canceled',
      }),
    );
    const response = await app.inject({
      method: 'GET',
      url: '/api/message-bundles/bundle-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(response.statusCode, 404, response.body);
    assert.deepEqual(
      deps.messageStore.getById.mock.calls.map((call) => call.arguments[0]),
      ['bundle-1'],
    );
  });

  it('converges a recalled source to a tombstone without returning its body', async () => {
    messages.set(
      'source-1',
      sourceMessage({
        content: 'recalled private body',
        deliveryStatus: 'canceled',
        _tombstone: true,
        recall: { exposure: 'unseen' },
      }),
    );
    const response = await app.inject({
      method: 'GET',
      url: '/api/message-bundles/bundle-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = JSON.parse(response.body);
    assert.deepEqual(body.items, [{ status: 'tombstone', messageId: 'source-1', reason: 'source_unavailable' }]);
    assert.equal(response.body.includes('recalled private body'), false);
  });

  it('converges a hard-deleted source record to the same unavailable tombstone', async () => {
    messages.delete('source-1');
    const response = await app.inject({
      method: 'GET',
      url: '/api/message-bundles/bundle-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(JSON.parse(response.body).items, [
      { status: 'tombstone', messageId: 'source-1', reason: 'source_unavailable' },
    ]);
  });

  it('converges quote digest drift to source_changed without returning the changed body', async () => {
    messages.set(
      'bundle-1',
      targetMessage({
        extra: {
          messageBundle: {
            v: 1,
            sourceThreadId: 'source-thread',
            items: [
              {
                kind: 'quote',
                messageId: 'source-1',
                selectionStart: 0,
                selectionEnd: 8,
                sourceProjectionVersion: 1,
                sourceProjectionSha256: digestMessageBundleQuoteProjection('old body'),
              },
            ],
          },
        },
      }),
    );
    messages.set('source-1', sourceMessage({ content: 'changed private body' }));
    const response = await app.inject({
      method: 'GET',
      url: '/api/message-bundles/bundle-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(JSON.parse(response.body).items, [
      { status: 'tombstone', messageId: 'source-1', reason: 'source_changed' },
    ]);
    assert.equal(response.body.includes('changed private body'), false);
  });

  it('converges source permission loss to tombstones without reading source messages', async () => {
    deps.threadStore.get.mock.mockImplementation(async (id) => ({
      id,
      title: id === 'source-thread' ? 'Foreign Source' : 'Target Thread',
      createdBy: id === 'source-thread' ? 'another-user' : 'user-1',
    }));
    const response = await app.inject({
      method: 'GET',
      url: '/api/message-bundles/bundle-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(JSON.parse(response.body).items, [
      { status: 'tombstone', messageId: 'source-1', reason: 'source_unavailable' },
    ]);
    assert.deepEqual(
      deps.messageStore.getById.mock.calls.map((call) => call.arguments[0]),
      ['bundle-1'],
    );
  });
});
