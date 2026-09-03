import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';

async function fixture({ bindRace = false, statusError = false } = {}) {
  const [{ nativeThreadStatusRoutes }, { ThreadStore }, { SessionChainStore }, { AgentRegistry }] = await Promise.all([
    import('../dist/routes/native-thread-status-routes.js'),
    import('../dist/domains/cats/services/stores/ports/ThreadStore.js'),
    import('../dist/domains/cats/services/stores/ports/SessionChainStore.js'),
    import('../dist/domains/cats/services/agents/registry/AgentRegistry.js'),
  ]);
  const app = Fastify();
  const threadStore = new ThreadStore();
  const sessionChainStore = new SessionChainStore();
  const agentRegistry = new AgentRegistry();
  const source = threadStore.create('owner-1', 'Source');
  const target = threadStore.create('owner-1', 'Target');
  const sourceSession = sessionChainStore.create({
    cliSessionId: 'native-source',
    threadId: source.id,
    catId: 'codex',
    userId: 'owner-1',
  });
  const targetSession = sessionChainStore.create({ threadId: target.id, catId: 'codex', userId: 'owner-1' });
  const calls = [];
  agentRegistry.register('codex', {
    async *invoke() {},
    async requestNativeStatus(input) {
      calls.push({ kind: 'status', input });
      if (statusError) throw new Error('provider unavailable');
      return {
        runtimeSessionId: input.sessionId,
        source: 'codex_app_server',
        observedAt: 100,
        thread: { availability: 'available', status: 'idle', canAcceptDirectInput: true },
        capabilities: { availability: 'available', imageGeneration: true, namespaceTools: false, webSearch: true },
        permissionProfiles: { availability: 'available', activeId: ':workspace', profiles: [] },
        account: { availability: 'available', authenticated: true, kind: 'apiKey' },
        rateLimits: { availability: 'available', primary: { usedPercent: 10, resetsAt: null } },
        nativeThreadList: { availability: 'available', count: 7, boundThreadPresent: true, hasMore: false },
      };
    },
    async requestNativeFork(input) {
      calls.push({ kind: 'fork', input });
      if (bindRace) await sessionChainStore.bindCliSessionId(targetSession.id, 'native-race-winner');
      return {
        sourceRuntimeSessionId: input.sessionId,
        forkedRuntimeSessionId: 'native-fork',
        source: 'codex_app_server',
        observedAt: 101,
      };
    },
  });
  await app.register(nativeThreadStatusRoutes, { threadStore, sessionChainStore, agentRegistry });
  await app.ready();
  return { app, calls, source, sourceSession, target, targetSession, threadStore, sessionChainStore };
}

const ownerHeaders = { 'x-cat-cafe-user': 'owner-1' };

test('status lists only exact active provider bindings without importing provider threads', async (t) => {
  const { app, source, threadStore } = await fixture();
  t.after(() => app.close());
  const before = await threadStore.list('owner-1');
  const response = await app.inject({
    method: 'GET',
    url: `/api/threads/${source.id}/native-status`,
    headers: ownerHeaders,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().statuses.length, 1);
  assert.equal(response.json().statuses[0].catId, 'codex');
  assert.equal(response.json().statuses[0].observation, 'available');
  assert.equal(response.json().statuses[0].runtimeSessionId, 'native-source');
  assert.equal(response.json().statuses[0].nativeThreadList.count, 7);
  const after = await threadStore.list('owner-1');
  assert.deepEqual(
    after.map((thread) => thread.id),
    before.map((thread) => thread.id),
  );
});

test('status failure does not forge app-server provenance or a fresh observation timestamp', async (t) => {
  const { app, source } = await fixture({ statusError: true });
  t.after(() => app.close());
  const response = await app.inject({
    method: 'GET',
    url: `/api/threads/${source.id}/native-status`,
    headers: ownerHeaders,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().statuses, [
    {
      catId: 'codex',
      runtimeSessionId: 'native-source',
      observation: 'unavailable',
      reason: 'provider_request_failed',
    },
  ]);
});

test('fork binds provider identity only after both Clowder AI threads and target session are authorized', async (t) => {
  const { app, calls, source, target, targetSession, sessionChainStore } = await fixture();
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: `/api/threads/${source.id}/sessions/codex/fork-native`,
    headers: ownerHeaders,
    payload: { targetThreadId: target.id },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    outcome: 'bound',
    targetThreadId: target.id,
    targetSessionId: targetSession.id,
    runtimeSessionId: 'native-fork',
    source: 'codex_app_server',
    observedAt: 101,
  });
  assert.equal((await sessionChainStore.get(targetSession.id)).cliSessionId, 'native-fork');
  assert.equal(calls.find((call) => call.kind === 'fork').input.sessionId, 'native-source');
});

test('fork leaves provider fork as unbound evidence when target binding CAS loses a race', async (t) => {
  const { app, source, target, targetSession, sessionChainStore } = await fixture({ bindRace: true });
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: `/api/threads/${source.id}/sessions/codex/fork-native`,
    headers: ownerHeaders,
    payload: { targetThreadId: target.id },
  });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), {
    error: 'Native fork could not bind the Clowder AI target',
    code: 'NATIVE_FORK_BIND_CONFLICT',
    providerEvidence: { runtimeSessionId: 'native-fork', binding: 'unbound' },
  });
  assert.equal((await sessionChainStore.get(targetSession.id)).cliSessionId, 'native-race-winner');
});

test('fork rejects an inaccessible target before provider execution', async (t) => {
  const { app, calls, source, threadStore } = await fixture();
  t.after(() => app.close());
  const foreign = threadStore.create('other-owner', 'Foreign');
  const response = await app.inject({
    method: 'POST',
    url: `/api/threads/${source.id}/sessions/codex/fork-native`,
    headers: ownerHeaders,
    payload: { targetThreadId: foreign.id },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(
    calls.some((call) => call.kind === 'fork'),
    false,
  );
});
