import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { registerCallbackMemoryRoutes } from '../dist/routes/callback-memory-routes.js';
import { evidenceRoutes } from '../dist/routes/evidence.js';

describe('HTTP/callback common message search contract', () => {
  let app;
  let calls;
  const response = { searchId: 'immutable-query', query: 'piano', results: [], meta: { freshness: 'unknown' } };
  const headers = { 'x-invocation-id': 'invocation', 'x-callback-token': 'token' };
  const store = { search: async () => [], getByAnchor: async () => null };

  beforeEach(async () => {
    calls = [];
    app = Fastify();
    registerCallbackAuthHook(
      app,
      {
        verify: async (id, token) =>
          id === 'invocation' && token === 'token'
            ? {
                ok: true,
                record: {
                  invocationId: id,
                  callbackToken: token,
                  userId: 'owner',
                  catId: 'codex61-sol',
                  threadId: 'foreground',
                  originTriggerMessageId: 'exact-question',
                },
              }
            : { ok: false, reason: 'unknown_invocation' },
      },
      {
        agentKeyRegistry: {
          verify: async (secret) =>
            secret === 'verified-agent-key'
              ? {
                  ok: true,
                  record: {
                    agentKeyId: 'test-agent-key',
                    userId: 'owner',
                    catId: 'codex61-sol',
                    scope: 'user-bound',
                  },
                }
              : { ok: false, reason: 'unknown_key' },
        },
      },
    );
    const messageSearchService = {
      search: async (input, principal) => {
        calls.push({ input, principal });
        return response;
      },
    };
    await app.register(evidenceRoutes, { evidenceStore: store, messageSearchService });
    await registerCallbackMemoryRoutes(app, { evidenceStore: store, messageSearchService });
    await app.ready();
  });

  afterEach(() => app.close());

  it('requires identity for message mode while preserving public document searches', async () => {
    const res = await app.inject('/api/evidence/search?q=piano&resultUnit=message');
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);
    assert.equal((await app.inject('/api/evidence/search?q=piano')).statusCode, 200);
  });

  it('uses the same validated input for human HTTP and invocation-bound callback', async () => {
    const query = 'q=piano&resultUnit=message&scope=threads&threadId=visible&messageSort=relevance&mode=hybrid&limit=3';
    const human = await app.inject({ url: `/api/evidence/search?${query}`, headers: { 'x-cat-cafe-user': 'owner' } });
    const cat = await app.inject({ url: `/api/callbacks/search-evidence?${query}`, headers });
    assert.equal(human.statusCode, 200);
    assert.equal(cat.statusCode, 200);
    assert.deepEqual(human.json(), response);
    assert.deepEqual(cat.json(), response);
    assert.deepEqual(
      calls.map((c) => c.input),
      [
        { query: 'piano', threadId: 'visible', sort: 'relevance', mode: 'hybrid', limit: 3 },
        { query: 'piano', threadId: 'visible', sort: 'relevance', mode: 'hybrid', limit: 3 },
      ],
    );
    assert.deepEqual(calls[0].principal, { userId: 'owner', viewer: { type: 'user' } });
    assert.deepEqual(calls[1].principal, {
      userId: 'owner',
      viewer: { type: 'cat', catId: 'codex61-sol' },
      source: { threadId: 'foreground', messageId: 'exact-question' },
    });
  });

  it('binds exclusion to server authentication, ignoring forged query identity/source values', async () => {
    const res = await app.inject({
      url: '/api/callbacks/search-evidence?q=piano&resultUnit=message&userId=intruder&sourceMessageId=old',
      headers: { ...headers, 'x-cat-cafe-user': 'intruder' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(calls[0].principal.userId, 'owner');
    assert.equal(calls[0].principal.source.messageId, 'exact-question');
    const human = await app.inject({
      url: '/api/evidence/search?q=piano&resultUnit=message&sourceMessageId=old',
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(human.statusCode, 200);
    assert.equal(calls[1].principal.source, undefined);
  });

  it('denies callback without verified credentials and rejects proxied human headers', async () => {
    assert.equal((await app.inject('/api/callbacks/search-evidence?q=piano&resultUnit=message')).statusCode, 401);
    const res = await app.inject({
      url: '/api/evidence/search?q=piano&resultUnit=message',
      headers: { 'x-cat-cafe-user': 'owner', 'x-forwarded-for': '192.0.2.1' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);
  });

  it('does not silently turn a global message scope into all knowledge or coverage search', async () => {
    for (const bad of ['scope=all', 'dimension=global', 'intent=coverage']) {
      const res = await app.inject({
        url: `/api/evidence/search?q=piano&resultUnit=message&${bad}`,
        headers: { 'x-cat-cafe-user': 'owner' },
      });
      assert.equal(res.statusCode, 400, bad);
    }
    const global = await app.inject({ url: '/api/callbacks/search-evidence?q=piano&resultUnit=message', headers });
    assert.equal(global.statusCode, 200);
    assert.equal(calls[0].input.threadId, undefined);
  });

  it('uses the verified persistent agent identity only for message queries, without an invented invocation source', async () => {
    for (const mode of ['lexical', 'semantic', 'hybrid']) {
      const res = await app.inject({
        url: `/api/callbacks/search-evidence?q=piano&resultUnit=message&mode=${mode}&userId=intruder&catId=other&sourceMessageId=forged`,
        headers: { 'x-agent-key-secret': 'verified-agent-key', 'x-cat-cafe-user': 'intruder' },
      });
      assert.equal(res.statusCode, 200, mode);
      const call = calls.at(-1);
      assert.equal(call.input.mode, mode);
      assert.deepEqual(call.principal, { userId: 'owner', viewer: { type: 'cat', catId: 'codex61-sol' } });
    }
    const count = calls.length;
    assert.equal(
      (
        await app.inject({
          url: '/api/callbacks/search-evidence?q=piano&resultUnit=message',
          headers: { 'x-agent-key-secret': 'invalid-key' },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/callbacks/search-evidence?q=piano&resultUnit=message&mode=delete',
          headers: { 'x-agent-key-secret': 'verified-agent-key' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/callbacks/search-evidence?q=piano',
          headers: { 'x-agent-key-secret': 'verified-agent-key' },
        })
      ).statusCode,
      401,
      'legacy document callback remains invocation-only',
    );
    assert.equal(calls.length, count);
  });
});
