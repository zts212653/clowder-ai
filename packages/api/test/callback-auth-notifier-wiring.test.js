/**
 * F174 D2b-1 — preHandler wiring of CallbackAuthSystemMessageNotifier.
 *
 * Proves: when registerCallbackAuthHook is given a notifier and the registry
 * exposes getRecord, a 401 surface-able failure looks up the record and calls
 * notifier.notify with the decoded threadId/catId/userId.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const RECORD = {
  invocationId: 'inv-001',
  callbackToken: 'tok-correct',
  threadId: 'thread-abc',
  catId: 'opus',
  userId: 'user-1',
};

function makeRegistry({ verifyResult, recordById }) {
  return {
    async verify(invocationId, _token) {
      void _token;
      return verifyResult(invocationId);
    },
    async peekRecord(invocationId) {
      return recordById?.(invocationId) ?? null;
    },
  };
}

function makeNotifierStub() {
  const calls = [];
  return {
    calls,
    async notify(params) {
      calls.push(params);
      return true;
    },
    hideSimilar() {
      // not exercised here
    },
  };
}

async function buildApp({ registry, notifier }) {
  const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');
  const app = Fastify({ logger: false });
  registerCallbackAuthHook(app, registry, { notifier });
  app.get('/api/callbacks/post-message', async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('preHandler × CallbackAuthSystemMessageNotifier wiring (F174-D2b-1)', () => {
  let notifier;

  beforeEach(() => {
    notifier = makeNotifierStub();
  });

  it('notify called with record metadata when invalid_token + record found', async () => {
    const registry = makeRegistry({
      verifyResult: () => ({ ok: false, reason: 'invalid_token' }),
      recordById: (id) => (id === RECORD.invocationId ? RECORD : null),
    });
    const app = await buildApp({ registry, notifier });

    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': 'inv-001', 'x-callback-token': 'tok-WRONG' },
    });

    assert.equal(res.statusCode, 401);
    assert.equal(notifier.calls.length, 1);
    const call = notifier.calls[0];
    assert.equal(call.threadId, 'thread-abc');
    assert.equal(call.catId, 'opus');
    assert.equal(call.userId, 'user-1');
    assert.equal(call.reason, 'invalid_token');
    assert.equal(call.tool, 'post-message'); // derived from /api/callbacks/{tool}
    await app.close();
  });

  it('notify called when expired + record found', async () => {
    const registry = makeRegistry({
      verifyResult: () => ({ ok: false, reason: 'expired' }),
      recordById: () => RECORD,
    });
    const app = await buildApp({ registry, notifier });
    await app.inject({
      method: 'GET',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': 'inv-001', 'x-callback-token': 'tok' },
    });
    assert.equal(notifier.calls.length, 1);
    assert.equal(notifier.calls[0].reason, 'expired');
    await app.close();
  });

  it('notify NOT called when peekRecord returns null (record evicted)', async () => {
    const registry = makeRegistry({
      verifyResult: () => ({ ok: false, reason: 'expired' }),
      recordById: () => null,
    });
    const app = await buildApp({ registry, notifier });
    await app.inject({
      method: 'GET',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': 'inv-x', 'x-callback-token': 'tok' },
    });
    assert.equal(notifier.calls.length, 0);
    await app.close();
  });

  it('notify NOT called when missing creds (no invocationId to lookup)', async () => {
    const registry = makeRegistry({
      verifyResult: () => ({ ok: false, reason: 'expired' }),
      recordById: () => RECORD,
    });
    const app = await buildApp({ registry, notifier });
    await app.inject({
      method: 'GET',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': 'inv-only' }, // missing token → missing_creds
    });
    assert.equal(notifier.calls.length, 0);
    await app.close();
  });

  it('notifier failure is non-fatal (still 401, no crash)', async () => {
    const registry = makeRegistry({
      verifyResult: () => ({ ok: false, reason: 'expired' }),
      recordById: () => RECORD,
    });
    const explosiveNotifier = {
      async notify() {
        throw new Error('boom');
      },
    };
    const app = await buildApp({ registry, notifier: explosiveNotifier });
    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': 'inv-001', 'x-callback-token': 'tok' },
    });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  it('preHandler still works without notifier (back-compat)', async () => {
    const registry = makeRegistry({
      verifyResult: () => ({ ok: false, reason: 'expired' }),
      recordById: () => RECORD,
    });
    const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');
    const app = Fastify({ logger: false });
    registerCallbackAuthHook(app, registry); // no options
    app.get('/api/callbacks/post-message', async () => ({ ok: true }));
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': 'inv-001', 'x-callback-token': 'tok' },
    });
    assert.equal(res.statusCode, 401);
    await app.close();
  });
});
