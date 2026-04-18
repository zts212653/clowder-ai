/**
 * GET /api/callbacks/thread-cats — callback-authenticated thread cats discovery
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';

function stubRegistry(records = new Map()) {
  return {
    verify: (invocationId, callbackToken) => {
      const record = records.get(invocationId);
      if (!record || record.callbackToken !== callbackToken) return null;
      return record;
    },
  };
}

function stubThreadStore(threads = new Map(), participants = new Map()) {
  return {
    get: async (id) => threads.get(id) ?? null,
    getParticipantsWithActivity: async (id) => participants.get(id) ?? [],
  };
}

describe('GET /api/callbacks/thread-cats', () => {
  let app;

  afterEach(async () => {
    if (app) await app.close();
  });

  async function setup({ records, threads, participants, services = new Map() } = {}) {
    const { registerCallbackThreadCatsRoutes } = await import('../dist/routes/callback-thread-cats-routes.js');
    const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');
    app = Fastify();
    registerCallbackAuthHook(app, stubRegistry(records ?? new Map()));
    registerCallbackThreadCatsRoutes(app, {
      threadStore: stubThreadStore(threads, participants),
      agentRegistry: { getAllEntries: () => services },
    });
    await app.ready();
    return app;
  }

  it('returns 401 when auth headers are missing', async () => {
    await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/thread-cats',
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 for invalid callback credentials', async () => {
    await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/thread-cats',
      headers: { 'x-invocation-id': 'bad', 'x-callback-token': 'bad' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 404 when thread does not exist', async () => {
    const records = new Map([
      ['inv-1', { invocationId: 'inv-1', callbackToken: 'tok-1', threadId: 't-gone', catId: 'opus' }],
    ]);
    await setup({ records });

    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/thread-cats',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'tok-1' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns participants and categorization for valid request', async () => {
    const records = new Map([
      ['inv-1', { invocationId: 'inv-1', callbackToken: 'tok-1', threadId: 't-1', catId: 'opus' }],
    ]);
    const threads = new Map([['t-1', { id: 't-1' }]]);
    const participants = new Map([
      ['t-1', [{ catId: 'opus', lastMessageAt: 1000, messageCount: 5, lastResponseHealthy: true }]],
    ]);
    const services = new Map([['opus', {}]]);

    await setup({ records, threads, participants, services });
    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/thread-cats',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'tok-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.threadId, 't-1');
    assert.equal(body.participants.length, 1);
    assert.equal(body.participants[0].catId, 'opus');
    assert.equal(body.participants[0].messageCount, 5);
    assert.equal(body.participants[0].lastResponseHealthy, true);
    // Categorization: opus is participant + has service → routableNow
    assert.equal(body.routableNow.length, 1);
    assert.equal(body.routableNow[0].catId, 'opus');
    assert.deepEqual(body.routableNotJoined, []);
    assert.deepEqual(body.notRoutable, []);
  });

  it('returns 400 when invocation has no threadId', async () => {
    const records = new Map([
      ['inv-1', { invocationId: 'inv-1', callbackToken: 'tok-1', threadId: '', catId: 'opus' }],
    ]);
    await setup({ records });

    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/thread-cats',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'tok-1' },
    });
    assert.equal(res.statusCode, 400);
  });
});
