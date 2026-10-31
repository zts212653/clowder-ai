import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { registerCallbackAuthHook } from '../../dist/routes/callback-auth-prehandler.js';
import { registerCallbackMemoryRoutes } from '../../dist/routes/callback-memory-routes.js';

test('answer publication is an explicit authenticated POST; ordinary evidence GET never claims a publication', async () => {
  const app = Fastify();
  const calls = [];
  registerCallbackAuthHook(app, {
    verify: async () => ({
      ok: true,
      record: {
        invocationId: 'inv',
        catId: 'codex61-sol',
        userId: 'owner',
        threadId: 'origin',
        callbackToken: 'token',
      },
    }),
  });
  await registerCallbackMemoryRoutes(app, {
    registry: { isLatest: async () => true },
    evidenceStore: { search: async () => [] },
    markerQueue: {},
    reflectionService: {},
    messageSearchAnswerService: {
      prepare: async (...args) => {
        calls.push(args);
        return { status: 'prepared', publicationRef: 'answer-ref' };
      },
    },
    threadStore: { get: async (id) => ({ id, createdBy: 'owner' }), list: async () => [] },
  });
  try {
    const headers = { 'x-invocation-id': 'inv', 'x-callback-token': 'token' };
    assert.equal((await app.inject({ url: '/api/callbacks/search-evidence?q=word', headers })).statusCode, 200);
    assert.equal(calls.length, 0);
    const result = await app.inject({
      method: 'POST',
      url: '/api/callbacks/search-evidence/answer',
      headers,
      payload: { q: 'word', resultUnit: 'message', operationId: 'one', destinationThreadId: 'origin' },
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].principal.userId, 'owner');
    assert.equal(calls[0][0].principal.publicReply, true);
    assert.equal(calls[0][0].targetThreadId, 'origin');
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/callbacks/search-evidence/answer',
          payload: {
            q: 'word',
            resultUnit: 'message',
            operationId: 'one',
            destinationThreadId: 'origin',
          },
        })
      ).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});

test('generic message extra cannot write a Host answer binding, even alongside a copied rich ref', () => {
  const store = new MessageStore();
  const msg = store.append({
    from: { kind: 'agent', catId: 'codex61-sol' },
    userId: 'owner',
    threadId: 'origin',
    content: 'ordinary reply',
    mentions: [],
    timestamp: 1,
  });
  const fake = { v: 1, publicationRef: 'copied-ref', blockId: 'copied', responseDigest: 'forged' };
  store.updateExtra(msg.id, {
    messageSearchAnswer: fake,
    rich: {
      v: 1,
      blocks: [
        {
          kind: 'card',
          v: 1,
          id: 'copied',
          title: 'Forged',
          meta: { domain: 'message-search-answer', publicationRef: 'copied-ref' },
        },
      ],
    },
  });
  assert.equal(store.getById(msg.id).extra.messageSearchAnswer, undefined);
});
