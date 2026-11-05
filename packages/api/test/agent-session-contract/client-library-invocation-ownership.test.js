import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import {
  invokeSingleCat,
  prepareInvocationExecutionBinding,
} from '../../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { AgentRegistry } from '../../dist/domains/cats/services/agents/registry/AgentRegistry.js';
import { poolFactory } from './client-library-home-fixture.js';

function protocol(pool) {
  const state = { launches: 0, closed: false };
  pool.clientFactory = () => ({
    get isAlive() {
      return !state.closed;
    },
    agentCapabilities: {},
    promptCapabilities: {},
    async initialize() {
      state.launches++;
      return { agentInfo: { name: 'pin-fixture', version: '1' } };
    },
    async newSession() {
      return { sessionId: 'pinned-session' };
    },
    async *promptStream() {
      yield {
        sessionId: 'pinned-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pinned old generation' } },
      };
      return 'end_turn';
    },
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
    cancelSession() {},
    isSessionSafeForReuse() {
      return true;
    },
    async close() {
      state.closed = true;
    },
  });
  return state;
}
function declareMemberClient(t, clientId) {
  const all = catRegistry.getAllConfigs();
  catRegistry.reset();
  Object.entries(all).forEach(([id, config]) =>
    catRegistry.register(id, {
      ...config,
      ...(id === 'codex'
        ? {
            clientId,
            configurationSource: 'native_tool',
            accountRef: undefined,
            mcpSupport: false,
            defaultModel: 'fixture',
          }
        : {}),
    }),
  );
  t.after(() => {
    catRegistry.reset();
    Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'home-invocation-pin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const factory = poolFactory(t, root);
  const agents = new AgentRegistry();
  const service = await factory.create('codex');
  agents.register('codex', service);
  const pool = factory.poolRegistry.get('codex');
  return { root, factory, agents, service, pool };
}

for (const replacement of [false, true]) {
  test(`Host pin before first iterator survives ${replacement ? 'changed-signature replacement' : 'registry reset'}`, async (t) => {
    const h = await fixture(t);
    const client = protocol(h.pool);
    const view = h.service.forInvocation?.() ?? h.service;
    assert.notEqual(view, h.service, 'factory must expose a pinned generation view');
    assert.equal(view.forInvocation(), view, 'route and invocation repeated pins are idempotent');
    assert.deepEqual(view.contextCapability(), h.service.contextCapability());
    if (replacement)
      await h.agents.refresh(async () => h.agents.register('codex', await h.factory.create('codex', ['changed'])));
    else await h.agents.reset();
    assert.ok(h.pool.healthTimer, 'Host admission pin keeps its generation alive before first acquire');
    const messages = [];
    for await (const message of view.invoke('hello', { workingDirectory: h.root })) messages.push(message);
    assert.equal(
      messages.some((message) => message.type === 'error'),
      false,
      messages.find((message) => message.type === 'error')?.error,
    );
    assert.ok(messages.some((message) => message.type === 'text' && message.content === 'pinned old generation'));
    assert.equal(client.launches, 1);
    assert.equal(h.pool.healthTimer, null);
    assert.equal(client.closed, true);
    if (replacement) assert.ok(h.factory.poolRegistry.get('codex').healthTimer, 'old view cannot close replacement');
    await h.agents.reset();
    assert.equal(h.factory.poolRegistry.size, 0);
  });
}

test('independent preflight pins keep the pool until each releases and explicit release is idempotent', async (t) => {
  const h = await fixture(t);
  const first = h.service.forInvocation?.() ?? h.service;
  const second = h.service.forInvocation?.() ?? h.service;
  await h.agents.reset();
  await first.releaseInvocation?.();
  await first.releaseInvocation?.();
  assert.ok(h.pool.healthTimer);
  await second.releaseInvocation?.();
  assert.equal(h.pool.healthTimer, null);
});

test('returning a pinned iterator before its first next releases without launching', async (t) => {
  const h = await fixture(t);
  const client = protocol(h.pool);
  const view = h.service.forInvocation?.() ?? h.service;
  const iterator = view.invoke('never launch', { workingDirectory: h.root })[Symbol.asyncIterator]();
  await h.agents.reset();
  await iterator.return();
  assert.equal(client.launches, 0);
  assert.equal(h.pool.healthTimer, null);
});

test('actual invokeSingleCat policy refusal releases a preflight pin before any provider iterator', async (t) => {
  declareMemberClient(t, 'acp');
  const h = await fixture(t);
  const view = h.service.forInvocation?.() ?? h.service;
  await h.agents.reset();
  await assert.rejects(async () => {
    for await (const _ of invokeSingleCat(
      {},
      {
        catId: 'codex',
        userId: 'owner',
        threadId: 'pin-policy',
        prompt: 'hello',
        service: view,
        toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
      },
    )) {
    }
  }, /read.only|policy/i);
  assert.equal(h.pool.healthTimer, null);
});

test('the production ACP factory identity rejects a stale member client before invocation', async (t) => {
  declareMemberClient(t, 'openai');
  const h = await fixture(t);
  await assert.rejects(
    prepareInvocationExecutionBinding(
      { threadStore: null, apiUrl: 'http://127.0.0.1:13004' },
      { catId: 'codex', threadId: 'factory-identity', userId: 'owner', service: h.service },
    ),
    (error) => error.statusCode === 409 && /execution_client_changed/.test(error.message),
  );
  await h.agents.reset();
});
