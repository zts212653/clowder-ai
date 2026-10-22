import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { closeStaleAcpPools } from '../../dist/domains/cats/services/agents/providers/acp/acp-pool-registry.js';
import { AgentRegistry } from '../../dist/domains/cats/services/agents/registry/AgentRegistry.js';
import { library, poolFactory } from './client-library-home-fixture.js';

test('persisted library member is prepared before Host L0/policy admission without legacy environment binding', async (t) => {
  let builds = 0;
  const actual = new AcpAgentService({
    catId: 'codex',
    pool: {},
    poolKey: {},
    projectRoot: '/tmp',
    providerName: 'google',
    antigravity: { profile: {}, profileHome: '/tmp' },
  });
  const h = await library(t, async () => {
    builds++;
    return actual;
  });
  const stop = await h.activate();
  t.after(() => stop?.());
  assert.equal(builds, 1);
  const view = h.service.forInvocation();
  assert.equal(view.injectsL0Natively?.(), true);
  assert.equal(view.supportsToolExecutionPolicy?.({ mode: 'read_only', replayDeniedToolNames: [] }), true);
  assert.deepEqual(view.freshnessCarrierCapability?.(), actual.freshnessCarrierCapability());
  await stop();
  assert.equal(h.service.injectsL0Natively?.(), undefined);
});

test('failed persisted-member preparation rolls back every client registration before activation returns', async (t) => {
  const h = await library(t, async () => {
    throw new Error('home bootstrap unavailable');
  });
  await assert.rejects(h.activate(), /home bootstrap unavailable/);
  assert.equal(h.registry.has(h.ref), false);
  assert.equal(h.registry.has({ ...h.ref, contributionId: 'second' }), false);
  assert.equal(h.service.contextCapability?.(), undefined);
});

test('failed activation waits for a blocked successful preparation before disposing all prepared members', async (t) => {
  let unblock;
  const blocked = new Promise((resolve) => {
    unblock = resolve;
  });
  let announceStarted;
  const started = new Promise((resolve) => {
    announceStarted = resolve;
  });
  let factory;
  const h = await library(
    t,
    async (catId) => {
      if (catId === 'fast-fail') throw new Error('fast bootstrap failure');
      announceStarted();
      await blocked;
      return factory.create(catId);
    },
    {
      catIds: ['fast-fail', 'slow-success'],
    },
  );
  factory = poolFactory(t, h.rootDir);
  const activation = h.activate();
  let settled = false;
  void activation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await started;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'activation must not finish while a started preparation is still pending');
    assert.equal(factory.pools.size, 0, 'rollback must not race a pending preparation');
    unblock();
    await assert.rejects(activation, /fast bootstrap failure/);
    assert.equal(factory.pools.size, 1, 'late success really constructed an ACP process pool');
    assert.equal(factory.poolRegistry.size, 0, 'failed activation removes the pool it prepared');
    for (const pool of factory.pools) assert.equal(pool.healthTimer, null, 'rollback stops the real health timer');
    assert.equal(h.registry.has(h.ref), false);
    assert.equal(h.registry.has({ ...h.ref, contributionId: 'second' }), false);
  } finally {
    unblock();
    await activation.catch(() => {});
  }
});

test('deactivation disposes a prepared pool even before the first invocation', async (t) => {
  let factory;
  const h = await library(t, (catId) => factory.create(catId));
  factory = poolFactory(t, h.rootDir);
  const stop = await h.activate();
  const pool = factory.poolRegistry.get('codex');
  assert.ok(pool.healthTimer, 'preparation starts the production health timer');
  await stop();
  await stop();
  assert.equal(factory.poolRegistry.size, 0);
  assert.equal(pool.healthTimer, null);
});

test('a preparation lease cannot close a pool held by another live service generation', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'home-client-pool-lease-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const factory = poolFactory(t, rootDir);
  const live = await factory.create('codex');
  const candidate = await factory.create('codex');
  const shared = factory.poolRegistry.get('codex');
  await candidate.disposeHostService();
  await candidate.disposeHostService();
  assert.equal(factory.poolRegistry.get('codex'), shared);
  assert.ok(shared.healthTimer, 'the live generation still owns the shared pool');
  await live.disposeHostService();
  assert.equal(factory.poolRegistry.size, 0);
  assert.equal(shared.healthTimer, null);
});

test('failed activation releases its preparation without closing a live shared pool', async (t) => {
  let factory;
  const h = await library(
    t,
    async (catId) => {
      if (catId === 'fast-fail') throw new Error('fast bootstrap failure');
      return factory.create(catId);
    },
    { catIds: ['fast-fail', 'slow-success'] },
  );
  factory = poolFactory(t, h.rootDir);
  const live = await factory.create('slow-success');
  const pool = factory.poolRegistry.get('slow-success');
  await assert.rejects(h.activate(), /fast bootstrap failure/);
  assert.equal(h.registry.has(h.ref), false);
  assert.equal(factory.poolRegistry.get('slow-success'), pool);
  assert.ok(pool.healthTimer, 'another live owner keeps the shared generation alive');
  await live.disposeHostService();
  assert.equal(factory.poolRegistry.size, 0);
  assert.equal(pool.healthTimer, null);
});

test('disposing an older preparation does not remove a replacement pool generation', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'home-client-pool-replacement-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const factory = poolFactory(t, rootDir);
  const old = await factory.create('codex', ['--old']);
  const current = await factory.create('codex', ['--current']);
  const currentPool = factory.poolRegistry.get('codex');
  await old.disposeHostService();
  assert.equal(factory.poolRegistry.get('codex'), currentPool);
  assert.ok(currentPool.healthTimer);
  await current.disposeHostService();
  assert.equal(factory.poolRegistry.size, 0);
  assert.equal(currentPool.healthTimer, null);
});

test('direct registry reset cannot leave a phantom owner after plugin activation rollback', async (t) => {
  let factory;
  const h = await library(
    t,
    async (catId) => {
      if (catId === 'fast-fail') throw new Error('fast bootstrap failure');
      return factory.create(catId);
    },
    { catIds: ['fast-fail', 'slow-success'] },
  );
  factory = poolFactory(t, h.rootDir);
  const agents = new AgentRegistry();
  agents.register('slow-success', await factory.create('slow-success'));
  await agents.reset();
  await assert.rejects(h.activate(), /fast bootstrap failure/);
  assert.equal(agents.has('slow-success'), false);
  assert.equal(h.registry.has(h.ref), false);
  assert.equal(factory.poolRegistry.size, 0, 'the superseded direct owner must not keep the candidate pool alive');
  for (const pool of factory.pools) assert.equal(pool.healthTimer, null);
  agents.register('slow-success', await factory.create('slow-success'));
  await assert.rejects(
    agents.refresh(() => h.activate()),
    /fast bootstrap failure/,
  );
  assert.equal(factory.poolRegistry.size, 0, 'a failed refresh also retires the captured direct generation');
  for (const pool of factory.pools) assert.equal(pool.healthTimer, null);
});

test('registry refresh transfers ownership to a warm direct generation before releasing the old one', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'home-client-registry-refresh-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const factory = poolFactory(t, rootDir);
  const agents = new AgentRegistry();
  agents.register('codex', await factory.create('codex'));
  const pool = factory.poolRegistry.get('codex');
  await agents.refresh(async () => agents.register('codex', await factory.create('codex')));
  assert.equal(factory.poolRegistry.get('codex'), pool, 'a compatible rebuild must retain the warm pool');
  assert.ok(pool.healthTimer);
  await agents.reset();
  assert.equal(factory.poolRegistry.size, 0);
  assert.equal(pool.healthTimer, null);
});

test('direct-to-plugin registry refresh releases the old owner before plugin deactivation', async (t) => {
  let factory;
  const h = await library(t, (catId) => factory.create(catId));
  factory = poolFactory(t, h.rootDir);
  const agents = new AgentRegistry();
  agents.register('codex', await factory.create('codex'));
  const pool = factory.poolRegistry.get('codex');
  let stop;
  await agents.refresh(async () => {
    stop = await h.activate();
    agents.register('codex', h.service);
  });
  assert.equal(factory.poolRegistry.get('codex'), pool);
  await stop();
  assert.equal(factory.poolRegistry.size, 0);
  assert.equal(pool.healthTimer, null);
});

test('reset lets an already running direct invocation finish before its pool lease is released', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'home-client-active-refresh-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const factory = poolFactory(t, rootDir);
  const agents = new AgentRegistry();
  const direct = await factory.create('codex');
  agents.register('codex', direct);
  const pool = factory.poolRegistry.get('codex');
  let closed = false;
  // The protocol edge is fake; the service, process pool, registry and timers are production instances.
  pool.clientFactory = () => ({
    get isAlive() {
      return !closed;
    },
    agentCapabilities: {},
    promptCapabilities: {},
    async initialize() {
      return { agentInfo: { name: 'owned-fixture', version: '1' } };
    },
    async newSession() {
      return { sessionId: 'live-native-session' };
    },
    async *promptStream() {
      yield {
        sessionId: 'live-native-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'completed after refresh' },
        },
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
      closed = true;
    },
  });
  const iterator = direct.invoke('hello', { workingDirectory: rootDir })[Symbol.asyncIterator]();
  try {
    const first = await iterator.next();
    assert.equal(first.value.type, 'session_init');
    await agents.refresh(async () => {
      await closeStaleAcpPools(factory.poolRegistry, new Set());
    });
    assert.equal(agents.has('codex'), false);
    assert.equal(closed, false, 'reset must not terminate the old in-flight carrier');
    assert.ok(pool.healthTimer, 'the in-flight invocation remains an actual owner');
    const rest = [];
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) rest.push(next.value);
    assert.equal(
      rest.some((message) => message.type === 'error'),
      false,
    );
    assert.ok(rest.some((message) => message.type === 'text' && message.content === 'completed after refresh'));
    assert.ok(rest.some((message) => message.type === 'done'));
  } finally {
    await iterator.return();
  }
  assert.equal(factory.poolRegistry.size, 0);
  assert.equal(pool.healthTimer, null);
  assert.equal(closed, true);
});
