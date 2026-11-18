import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { messagesRoutes } from '../dist/routes/messages.js';

test('history hides only verified canceled watcher auth cards, preserving stored evidence and pagination', async () => {
  const messageStore = new MessageStore();
  const userId = 'u';
  const threadId = 't';
  const add = (invocationId, reason = 'canceled') =>
    messageStore.append({
      from: { kind: 'system', service: 'callback-auth' },
      userId,
      threadId,
      content: 'auth failure',
      mentions: [],
      timestamp: Date.now(),
      source: { connector: 'callback-auth', label: 'Callback Auth', icon: 'legacy' },
      extra: {
        rich: {
          v: 1,
          blocks: [
            {
              v: 1,
              id: invocationId,
              kind: 'card',
              title: 'Callback Auth Failure',
              meta: {
                kind: 'callback_auth_failure',
                invocationId,
                catId: 'gpt52',
                userId,
                threadId,
                reason,
              },
            },
          ],
        },
      },
    });
  const hidden = await add('watcher');
  const ordinary = await add('ordinary');
  const invalid = await add('watcher-token', 'invalid_token');
  messageStore.append({
    from: { kind: 'system', service: 'routing-guard-failure' },
    userId,
    threadId,
    content: 'retired routing diagnostic',
    mentions: [],
    timestamp: Date.now(),
    source: { connector: 'routing-guard-failure', label: 'Retired routing guard', icon: 'legacy' },
  });
  const app = Fastify();
  let lookupUnavailable = false;
  await app.register(messagesRoutes, {
    messageStore,
    registry: {},
    router: {},
    socketManager: {},
    turnExecutionStore: {
      get: async (id) => {
        if (lookupUnavailable) throw new Error('execution read unavailable');
        return {
          invocationId: id,
          userId,
          threadId,
          catId: 'gpt52',
          status: 'canceled',
          executionKind: id === 'ordinary' ? 'ordinary' : 'watcher',
          terminalReason: 'user_cancel',
        };
      },
    },
  });
  try {
    const response = await app.inject({
      url: '/api/messages?threadId=t&limit=2',
      headers: { 'x-cat-cafe-user': userId },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      response.json().messages.map((row) => row.id),
      [ordinary.id, invalid.id],
    );
    assert.equal(response.json().hasMore, false);
    const recovered = await app.inject({
      url: '/api/messages?threadId=t&limit=2&afterVisibility=',
      headers: { 'x-cat-cafe-user': userId },
    });
    assert.equal(recovered.statusCode, 200);
    assert.deepEqual(
      recovered.json().messages.map((row) => row.id),
      [ordinary.id, invalid.id],
      'incremental recovery obeys the same history filter',
    );
    assert.equal((await messageStore.getById(hidden.id)).content, 'auth failure', 'no production backfill or deletion');
    lookupUnavailable = true;
    const unknown = await app.inject({
      url: '/api/messages?threadId=t&limit=10',
      headers: { 'x-cat-cafe-user': userId },
    });
    assert.equal(unknown.statusCode, 200, 'a diagnostic lookup must not break ordinary history');
    assert.equal(unknown.json().messages.length, 3, 'unknown cancellation identity never hides evidence');
    const unknownRecovery = await app.inject({
      url: '/api/messages?threadId=t&limit=10&afterVisibility=',
      headers: { 'x-cat-cafe-user': userId },
    });
    assert.equal(
      unknownRecovery.json().messages.length,
      3,
      'browser recovery retains diagnostics whose execution identity is unknown',
    );
  } finally {
    await app.close();
  }
});

test('a hidden-only recovery advances the watermark and leaves later visible work reachable', async () => {
  const store = new MessageStore();
  const userId = 'u',
    threadId = 't';
  const visible = (content) =>
    store.append({ userId, threadId, from: { kind: 'user', userId }, content, mentions: [], timestamp: Date.now() });
  visible('before hidden recovery');
  const app = Fastify();
  await app.register(messagesRoutes, {
    messageStore: store,
    registry: {},
    router: {},
    socketManager: {},
    turnExecutionStore: {
      get: async () => ({
        invocationId: 'canceled',
        userId,
        threadId,
        catId: 'gpt52',
        executionKind: 'watcher',
        status: 'canceled',
      }),
    },
  });
  const read = async (watermark) =>
    (
      await app.inject({
        url:
          '/api/messages?threadId=t&limit=1' +
          (watermark === undefined ? '' : '&afterVisibility=' + encodeURIComponent(watermark)),
        headers: { 'x-cat-cafe-user': userId },
      })
    ).json();
  try {
    const baseline = await read();
    const hidden = store.append({
      userId,
      threadId,
      from: { kind: 'system', service: 'callback-auth' },
      content: 'canceled',
      mentions: [],
      timestamp: Date.now(),
      source: { connector: 'callback-auth', label: 'Callback Auth', icon: 'legacy' },
      extra: {
        rich: {
          v: 1,
          blocks: [
            {
              v: 1,
              id: 'card',
              kind: 'card',
              title: 'Callback Auth Failure',
              meta: {
                kind: 'callback_auth_failure',
                invocationId: 'canceled',
                catId: 'gpt52',
                userId,
                threadId,
                reason: 'canceled',
              },
            },
          ],
        },
      },
    });
    const recovery = await read(baseline.historyWatermark);
    assert.ok(!recovery.messages.some((row) => row.id === hidden.id));
    assert.notEqual(
      recovery.historyWatermark,
      baseline.historyWatermark,
      'hidden publication still advances the raw scan bookmark',
    );
    const later = visible('later visible work');
    const next = await read(recovery.historyWatermark);
    assert.ok(next.messages.some((row) => row.id === later.id));
    assert.ok(!next.messages.some((row) => row.id === hidden.id));
    assert.equal(store.getById(hidden.id).content, 'canceled', 'read projection does not delete audit evidence');
  } finally {
    await app.close();
  }
});
