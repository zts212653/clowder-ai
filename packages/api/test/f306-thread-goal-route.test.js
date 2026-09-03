import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';

async function fixture({ providerError, providerGoal = null } = {}) {
  const [{ nativeThreadGoalRoutes }, { ThreadStore }, { SessionChainStore }, { MessageStore }, { AgentRegistry }] =
    await Promise.all([
      import('../dist/routes/native-thread-goal-routes.js'),
      import('../dist/domains/cats/services/stores/ports/ThreadStore.js'),
      import('../dist/domains/cats/services/stores/ports/SessionChainStore.js'),
      import('../dist/domains/cats/services/stores/ports/MessageStore.js'),
      import('../dist/domains/cats/services/agents/registry/AgentRegistry.js'),
    ]);
  const app = Fastify();
  const threadStore = new ThreadStore();
  const sessionChainStore = new SessionChainStore();
  const messageStore = new MessageStore();
  const agentRegistry = new AgentRegistry();
  const calls = [];
  const thread = threadStore.create('owner-1', 'Goal journey');
  sessionChainStore.create({
    cliSessionId: 'native-1',
    threadId: thread.id,
    catId: 'codex',
    userId: 'owner-1',
  });
  agentRegistry.register('codex', {
    async *invoke() {},
    async requestNativeGoal(input) {
      calls.push(input);
      if (providerError) throw providerError;
      if (input.request.action === 'clear') {
        return { action: 'clear', runtimeSessionId: 'native-1', goal: null };
      }
      if (input.request.action === 'get') {
        return { action: 'get', runtimeSessionId: 'native-1', goal: providerGoal };
      }
      return {
        action: 'set',
        runtimeSessionId: 'native-1',
        goal: {
          objective: input.request.objective,
          status: input.request.status,
          tokenBudget: input.request.tokenBudget ?? null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 100,
          updatedAt: 101,
        },
      };
    },
  });
  await app.register(nativeThreadGoalRoutes, {
    threadStore,
    sessionChainStore,
    messageStore,
    agentRegistry,
    isSessionBusy: () => false,
  });
  await app.ready();
  return { app, agentRegistry, calls, messageStore, sessionChainStore, thread, threadStore };
}

const ownerHeaders = { 'x-cat-cafe-user': 'owner-1' };

test('goal journey authenticates, persists, syncs, reads, and clears through ThreadStore truth', async (t) => {
  const { app, calls, messageStore, thread, threadStore } = await fixture();
  t.after(() => app.close());
  const anonymous = await app.inject({ method: 'GET', url: `/api/threads/${thread.id}/goal` });
  assert.equal(anonymous.statusCode, 401);

  const saved = await app.inject({
    method: 'PUT',
    url: `/api/threads/${thread.id}/goal`,
    headers: ownerHeaders,
    payload: { objective: 'Ship Phase C', status: 'active', tokenBudget: 20_000, catId: 'codex' },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().goal.objective, 'Ship Phase C');
  assert.equal(saved.json().goal.sync.state, 'synced');
  assert.equal((await threadStore.get(thread.id)).goal.revision, 2);

  const read = await app.inject({ method: 'GET', url: `/api/threads/${thread.id}/goal`, headers: ownerHeaders });
  assert.deepEqual(read.json().goal, saved.json().goal);

  const cleared = await app.inject({
    method: 'DELETE',
    url: `/api/threads/${thread.id}/goal`,
    headers: ownerHeaders,
    payload: { catId: 'codex' },
  });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json().goal, null);
  const clearFence = (await threadStore.get(thread.id)).goal;
  assert.equal(clearFence.intent, 'clear');
  assert.equal(clearFence.sync.state, 'synced');
  assert.equal(typeof clearFence.clearedAt, 'number');
  const messages = await messageStore.getByThread(thread.id, 20, 'owner-1');
  assert.deepEqual(
    messages.map((message) => ({ content: message.content, event: message.extra?.semanticEvent })),
    [
      {
        content: '当前目标：Ship Phase C',
        event: {
          v: 1,
          id: `native-goal:${thread.id}:2:updated`,
          kind: 'goal',
          occurredAt: 101,
          state: 'updated',
          revision: 2,
          objective: 'Ship Phase C',
          status: 'active',
          source: 'codex_app_server',
          observedAt: 101,
          provenance: { provider: 'openai_codex', carrier: 'app_server', nativeType: 'thread/goal/updated' },
        },
      },
      {
        content: '当前目标已清除',
        event: {
          v: 1,
          id: `native-goal:${thread.id}:4:cleared`,
          kind: 'goal',
          occurredAt: clearFence.clearedAt,
          state: 'cleared',
          revision: 4,
          source: 'codex_app_server',
          observedAt: clearFence.clearedAt,
          provenance: { provider: 'openai_codex', carrier: 'app_server', nativeType: 'thread/goal/cleared' },
        },
      },
    ],
  );
  assert.deepEqual(
    calls.map((call) => call.request.action),
    ['set', 'clear'],
  );
});

test('provider unavailability never deletes set intent or a pending clear tombstone', async (t) => {
  const { app, thread, threadStore } = await fixture({
    providerError: new Error('codex_native_session_owner_unavailable'),
  });
  t.after(() => app.close());
  const saved = await app.inject({
    method: 'PUT',
    url: `/api/threads/${thread.id}/goal`,
    headers: ownerHeaders,
    payload: { objective: 'Survive provider outage', status: 'paused', catId: 'codex' },
  });
  assert.equal(saved.statusCode, 202);
  assert.equal(saved.json().goal.sync.state, 'unavailable');
  assert.equal((await threadStore.get(thread.id)).goal.objective, 'Survive provider outage');

  const cleared = await app.inject({
    method: 'DELETE',
    url: `/api/threads/${thread.id}/goal`,
    headers: ownerHeaders,
    payload: { catId: 'codex' },
  });
  assert.equal(cleared.statusCode, 202);
  assert.equal(cleared.json().goal.intent, 'clear');
  assert.equal(cleared.json().goal.sync.state, 'unavailable');
  assert.equal((await threadStore.get(thread.id)).goal.intent, 'clear');
});

test('refresh adopts a provider goal only when local truth is still absent', async (t) => {
  const providerGoal = {
    objective: 'Recovered provider goal',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 12,
    timeUsedSeconds: 3,
    createdAt: 100,
    updatedAt: 102,
  };
  const { app, thread, threadStore } = await fixture({ providerGoal });
  t.after(() => app.close());
  const refreshed = await app.inject({
    method: 'POST',
    url: `/api/threads/${thread.id}/goal/reconcile`,
    headers: ownerHeaders,
    payload: { catId: 'codex', mode: 'refresh' },
  });
  assert.equal(refreshed.statusCode, 200);
  assert.equal(refreshed.json().goal.objective, 'Recovered provider goal');
  assert.equal(refreshed.json().goal.sync.state, 'synced');
  assert.equal((await threadStore.get(thread.id)).goal.revision, 1);
});

test('refresh never reports a stale local goal as synced when the provider has no goal', async (t) => {
  const { app, thread, threadStore } = await fixture();
  t.after(() => app.close());
  const saved = await app.inject({
    method: 'PUT',
    url: `/api/threads/${thread.id}/goal`,
    headers: ownerHeaders,
    payload: { objective: 'Preserve owner intent', status: 'active', catId: 'codex' },
  });
  assert.equal(saved.statusCode, 200);

  const refreshed = await app.inject({
    method: 'POST',
    url: `/api/threads/${thread.id}/goal/reconcile`,
    headers: ownerHeaders,
    payload: { catId: 'codex', mode: 'refresh' },
  });

  assert.equal(refreshed.statusCode, 202);
  assert.equal(refreshed.json().native.state, 'unavailable');
  assert.equal(refreshed.json().goal.objective, 'Preserve owner intent');
  assert.equal(refreshed.json().goal.sync.state, 'unavailable');
  assert.equal(refreshed.json().goal.sync.reason, 'provider_goal_absent');
  assert.equal((await threadStore.get(thread.id)).goal.sync.state, 'unavailable');
});

test('refresh preserves a durable clear fence even when the native session disappeared', async (t) => {
  const { app, calls, sessionChainStore, thread, threadStore } = await fixture();
  t.after(() => app.close());
  await app.inject({
    method: 'PUT',
    url: `/api/threads/${thread.id}/goal`,
    headers: ownerHeaders,
    payload: { objective: 'Clear me', status: 'active', catId: 'codex' },
  });
  await app.inject({
    method: 'DELETE',
    url: `/api/threads/${thread.id}/goal`,
    headers: ownerHeaders,
    payload: { catId: 'codex' },
  });
  const active = await sessionChainStore.getActive('codex', thread.id, 'owner-1');
  await sessionChainStore.update(active.id, { status: 'sealed' });
  const callCount = calls.length;

  const refreshed = await app.inject({
    method: 'POST',
    url: `/api/threads/${thread.id}/goal/reconcile`,
    headers: ownerHeaders,
    payload: { catId: 'codex', mode: 'refresh' },
  });

  assert.equal(refreshed.statusCode, 200);
  assert.equal(refreshed.json().goal, null);
  assert.equal(calls.length, callCount);
  assert.equal((await threadStore.get(thread.id)).goal.sync.state, 'synced');
});

test('refresh persists provider/local divergence as an unavailable fenced revision', async (t) => {
  const providerGoal = {
    objective: 'Different provider goal',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 100,
    updatedAt: 500,
  };
  const { app, thread, threadStore } = await fixture({ providerGoal });
  t.after(() => app.close());
  await app.inject({
    method: 'PUT',
    url: `/api/threads/${thread.id}/goal`,
    headers: ownerHeaders,
    payload: { objective: 'Owner goal', status: 'paused', catId: 'codex' },
  });
  const before = (await threadStore.get(thread.id)).goal;

  const refreshed = await app.inject({
    method: 'POST',
    url: `/api/threads/${thread.id}/goal/reconcile`,
    headers: ownerHeaders,
    payload: { catId: 'codex', mode: 'refresh' },
  });

  assert.equal(refreshed.statusCode, 202);
  assert.equal(refreshed.json().goal.sync.reason, 'provider_goal_conflict');
  assert.equal(refreshed.json().goal.revision, before.revision + 1);
  assert.equal((await threadStore.get(thread.id)).goal.sync.state, 'unavailable');
});

test('refresh keeps an equal provider goal synced instead of manufacturing a conflict', async (t) => {
  const providerGoal = {
    objective: 'Owner goal',
    status: 'paused',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 100,
    updatedAt: 500,
  };
  const { app, thread, threadStore } = await fixture({ providerGoal });
  t.after(() => app.close());
  await app.inject({
    method: 'PUT',
    url: `/api/threads/${thread.id}/goal`,
    headers: ownerHeaders,
    payload: { objective: 'Owner goal', status: 'paused', catId: 'codex' },
  });
  const before = (await threadStore.get(thread.id)).goal;

  const refreshed = await app.inject({
    method: 'POST',
    url: `/api/threads/${thread.id}/goal/reconcile`,
    headers: ownerHeaders,
    payload: { catId: 'codex', mode: 'refresh' },
  });

  assert.equal(refreshed.statusCode, 200);
  assert.equal(refreshed.json().native.state, 'synced');
  assert.equal(refreshed.json().goal.sync.state, 'synced');
  assert.equal(refreshed.json().goal.sync.reason, undefined);
  assert.equal(refreshed.json().goal.revision, before.revision);
});

test('goal route exposes native choices and rejects ambiguous mutation before writing an intent', async (t) => {
  const { app, agentRegistry, sessionChainStore, thread, threadStore } = await fixture();
  t.after(() => app.close());
  sessionChainStore.create({
    cliSessionId: 'native-terra-1',
    threadId: thread.id,
    catId: 'codex-terra',
    userId: 'owner-1',
  });
  agentRegistry.register('codex-terra', {
    async *invoke() {},
    async requestNativeGoal() {
      throw new Error('not_expected');
    },
  });

  const read = await app.inject({ method: 'GET', url: `/api/threads/${thread.id}/goal`, headers: ownerHeaders });
  assert.deepEqual(read.json().nativeTargets, [{ catId: 'codex' }, { catId: 'codex-terra' }]);
  const ambiguous = await app.inject({
    method: 'PUT',
    url: `/api/threads/${thread.id}/goal`,
    headers: ownerHeaders,
    payload: { objective: 'Ambiguous', status: 'active' },
  });
  assert.equal(ambiguous.statusCode, 409);
  assert.equal(ambiguous.json().code, 'NATIVE_SESSION_SELECTION_REQUIRED');
  assert.equal((await threadStore.get(thread.id)).goal, undefined);
});
