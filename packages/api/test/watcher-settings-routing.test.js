import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry, WATCHER_CONFIG_DEFAULTS } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { readWatcherOutputFence } from '../dist/domains/concierge/watcher/watcher-output-fence.js';
import { watcherRoutes } from '../dist/routes/watcher.js';

const owner = process.env.DEFAULT_OWNER_USER_ID ?? 'default-user';
const headers = { host: 'localhost', origin: 'http://localhost:3171' };
async function world(t) {
  const app = Fastify(),
    configs = new MemoryConciergeConfigStore(),
    threads = new ThreadStore();
  const executions = new InMemoryTurnExecutionStore();
  const capabilityReads = [];
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = owner;
  });
  await app.register(watcherRoutes, {
    configStore: configs,
    threadStore: threads,
    labelStore: { list: async () => [] },
    turnExecutionStore: executions,
    capability: (id) => {
      capabilityReads.push(id);
      return ['codex', 'opus'].includes(id)
        ? { supported: true, context: 'ordinary', readOnly: 'tools' }
        : { supported: false, reason: 'not connected' };
    },
  });
  t.after(() => app.close());
  const write = (body) => app.inject({ method: 'PUT', url: '/api/watcher/config', headers, payload: body });
  return { app, configs, threads, executions, write, capabilityReads };
}
const routing = {
  primary: { catId: 'opus' },
  whenSameFamily: { mode: 'member', member: { catId: 'codex' } },
  maxConcurrentRuns: 6,
};

test('an unconfigured thread snapshot explains the empty selection without probing an empty member', async (t) => {
  const f = await world(t);
  const thread = await f.threads.create(owner);
  const response = await f.app.inject({ url: `/api/threads/${thread.id}/watcher`, headers });
  assert.equal(response.statusCode, 200, response.body);
  const state = response.json();
  assert.deepEqual(state.config, WATCHER_CONFIG_DEFAULTS);
  assert.equal(state.memberName, '选择主守望猫');
  assert.equal(state.capability.supported, false);
  assert.equal(f.capabilityReads.includes(''), false);
});

test('thread snapshots select the canonical routed primary before the legacy display alias', async (t) => {
  const f = await world(t);
  await f.configs.patch(owner, { watcher: { ...WATCHER_CONFIG_DEFAULTS, memberCatId: 'codex', routing } });
  const thread = await f.threads.create(owner);
  const response = await f.app.inject({ url: `/api/threads/${thread.id}/watcher`, headers });
  assert.equal(response.statusCode, 200, response.body);
  const cat = catRegistry.getOrThrow('opus').config;
  assert.equal(response.json().memberName, cat.nickname ?? cat.displayName);
  assert.equal(f.capabilityReads.at(-1), 'opus');
});

test('a legacy active panel supplies its first member only when no primary has been chosen', async (t) => {
  const f = await world(t);
  await f.configs.patch(owner, {
    watcher: {
      ...WATCHER_CONFIG_DEFAULTS,
      panel: { enabled: true, members: [{ catId: 'codex' }], maxConcurrentRuns: 6 },
    },
  });
  const thread = await f.threads.create(owner);
  const response = await f.app.inject({ url: `/api/threads/${thread.id}/watcher`, headers });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(f.capabilityReads.at(-1), 'codex');
  assert.ok(response.json().memberName);
  const settings = await f.app.inject({ url: '/api/watcher/config', headers });
  assert.equal(settings.json().config.enabled, false, 'reading a legacy choice cannot enable observation');
});

test('activation needs a primary and legacy member writes also select the ordinary-context path', async (t) => {
  const f = await world(t);
  assert.equal((await f.write({ expectedRevision: 0, enabled: true })).statusCode, 422);
  const selected = await f.write({ expectedRevision: 0, memberCatId: 'opus' });
  assert.equal(selected.statusCode, 200, selected.body);
  assert.equal(selected.json().config.routing.primary.catId, 'opus');
  assert.equal(selected.json().config.enabled, false);
});

test('owner route uses concrete capability across providers and maintains CAS and activation floor', async (t) => {
  const f = await world(t);
  f.executions.settledHead = async () => 27;
  const fresh = (await f.app.inject({ url: '/api/watcher/config', headers })).json();
  assert.equal(fresh.config.enabled, false);
  assert.equal(
    fresh.members.find((m) => m.catId === 'opus').capability.supported,
    true,
    'no provider whitelist in settings',
  );
  const saved = await f.write({ expectedRevision: 0, routing });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().config.enabled, false);
  assert.equal(saved.json().config.startedAfterSequence, 27);
  assert.equal((await f.write({ expectedRevision: 0, enabled: true, routing })).statusCode, 409);
  f.executions.settledHead = async () => 31;
  const enabled = await f.write({ expectedRevision: 1, enabled: true, routing });
  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.equal(enabled.json().config.startedAfterSequence, 31);
  assert.equal(enabled.json().config.scope, 'all');
  assert.equal(enabled.json().config.memberCatId, 'opus');
});

test('unconnected alternates and accounts are rejected without changing the saved choice', async (t) => {
  const f = await world(t);
  const bad = await f.write({
    expectedRevision: 0,
    routing: { ...routing, whenSameFamily: { mode: 'member', member: { catId: 'spark' } } },
  });
  assert.equal(bad.statusCode, 422);
  const account = await f.write({
    expectedRevision: 0,
    routing: { ...routing, primary: { catId: 'opus', accountRef: 'missing-account' } },
  });
  assert.equal(account.statusCode, 422);
  assert.equal((await f.configs.readWatcherConfig(owner)).revision, 0);
  assert.equal((await f.write({ expectedRevision: 0, routing })).statusCode, 200);
});

test('only selected primary and alternate can use output outlets; changing the choice changes the fence', async (t) => {
  const f = await world(t);
  await f.write({ expectedRevision: 0, enabled: true, routing });
  const thread = await f.threads.create(owner);
  const owners = { configs: f.configs, threads: f.threads, labels: { list: async () => [] } };
  const prior = await readWatcherOutputFence(owners, owner, thread.id, 'codex');
  assert.ok(prior);
  assert.ok(await readWatcherOutputFence(owners, owner, thread.id, 'opus'));
  assert.equal(await readWatcherOutputFence(owners, owner, thread.id, 'spark'), null);
  await f.write({ expectedRevision: 1, routing: { ...routing, whenSameFamily: { mode: 'skip' } } });
  assert.equal(await readWatcherOutputFence(owners, owner, thread.id, 'codex'), null);
  const next = await readWatcherOutputFence(owners, owner, thread.id, 'opus');
  assert.notEqual(next.configRevision, prior.configRevision);
});
