import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { registerCallbackThreadCatsRoutes } from '../dist/routes/callback-thread-cats-routes.js';

async function fixture(t) {
  const app = Fastify();
  t.after(() => app.close());
  const threads = new Map([
    ['owned', { id: 'owned', createdBy: 'owner' }],
    ['foreign', { id: 'foreign', createdBy: 'other-owner' }],
    ['deleted', { id: 'deleted', createdBy: 'owner', deletedAt: 123 }],
  ]);
  const reads = [];
  const services = new Map([['opus', {}]]);
  registerCallbackAuthHook(
    app,
    {
      verify: async (id, token) =>
        id === 'inv' && token === 'callback-test'
          ? { ok: true, record: { invocationId: id, threadId: 'owned', userId: 'owner', catId: 'opus' } }
          : { ok: false, reason: 'unknown_invocation' },
    },
    {
      agentKeyRegistry: {
        verify: async (secret) =>
          secret === 'agent-test'
            ? { ok: true, record: { agentKeyId: 'key', userId: 'owner', catId: 'gpt-pro', scope: 'user-bound' } }
            : { ok: false, reason: 'agent_key_unknown' },
      },
    },
  );
  registerCallbackThreadCatsRoutes(app, {
    threadStore: {
      get: async (id) => threads.get(id) ?? null,
      list: async () => [...threads.values()].filter((thread) => thread.createdBy === 'owner'),
      getParticipantsWithActivity: async (id) => {
        reads.push(id);
        return [{ catId: 'opus', lastMessageAt: 1, messageCount: 2 }];
      },
    },
    agentRegistry: { getAllEntries: () => services },
  });
  await app.ready();
  return { app, reads, services };
}

const agent = { 'x-agent-key-secret': 'agent-test' };
const invocation = { 'x-invocation-id': 'inv', 'x-callback-token': 'callback-test' };

test('cloud discovery reads the explicit owner thread and re-evaluates registered services', async (t) => {
  const { app, reads, services } = await fixture(t);
  const first = await app.inject({ url: '/api/callbacks/thread-cats?threadId=owned', headers: agent });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().threadId, 'owned');
  assert.deepEqual(
    first.json().routableNow.map((cat) => cat.catId),
    ['opus'],
  );
  services.clear();
  const second = await app.inject({ url: '/api/callbacks/thread-cats?threadId=owned', headers: agent });
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.json().routableNow, []);
  assert.equal(second.json().participants[0].messageCount, 2, 'history is not current eligibility');
  assert.deepEqual(reads, ['owned', 'owned']);
  assert.equal('cloudCatBindings' in first.json(), false);
});

test('cloud discovery rejects missing, malformed, foreign, missing and deleted thread scopes before activity reads', async (t) => {
  const { app, reads } = await fixture(t);
  for (const [suffix, expected] of [
    ['', 400],
    ['?threadId=', 400],
    ['?threadId=owned&threadId=foreign', 400],
    ['?threadId=foreign', 403],
    ['?threadId=missing', 403],
    ['?threadId=deleted', 410],
  ]) {
    const response = await app.inject({ url: `/api/callbacks/thread-cats${suffix}`, headers: agent });
    assert.equal(response.statusCode, expected, suffix);
  }
  assert.deepEqual(reads, []);
});

test('invocation discovery retains the current-thread default and owner scope for explicit targets', async (t) => {
  const { app, reads } = await fixture(t);
  const response = await app.inject({ url: '/api/callbacks/thread-cats', headers: invocation });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().threadId, 'owned');
  const denied = await app.inject({ url: '/api/callbacks/thread-cats?threadId=foreign', headers: invocation });
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(reads, ['owned']);
});

test('neither absent nor invalid credentials may discover cats', async (t) => {
  const { app, reads } = await fixture(t);
  for (const headers of [{}, { 'x-agent-key-secret': 'wrong' }]) {
    assert.equal((await app.inject({ url: '/api/callbacks/thread-cats?threadId=owned', headers })).statusCode, 401);
  }
  assert.deepEqual(reads, []);
});
