import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { routeParallel } from '../../dist/domains/cats/services/agents/routing/route-parallel.js';
import { routeSerial } from '../../dist/domains/cats/services/agents/routing/route-serial.js';
import { isolateAccountAuthEnvironment } from '../helpers/account-auth-environment.js';
import { routingJourneyDeps } from '../helpers/routing-journey-deps.js';
import { collect } from './fake-session-provider.js';

async function fixture(t, change) {
  t.after(isolateAccountAuthEnvironment());
  const all = catRegistry.getAllConfigs();
  const catId = 'prior-unconfirmed-admission';
  catRegistry.register(catId, {
    ...all.codex,
    id: catId,
    mcpSupport: false,
    configurationSource: 'native_tool',
    accountRef: undefined,
  });
  t.after(() => {
    catRegistry.reset();
    Object.entries(all).forEach(([id, config]) => {
      catRegistry.register(id, config);
    });
  });
  let calls = 0;
  const service = {
    async *invoke() {
      calls++;
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
  const { deps } = routingJourneyDeps(undefined, undefined, service);
  deps.services = { [catId]: service };
  const store = deps.invocationDeps.turnExecutionStore;
  await store.createRunning({
    invocationId: 'prior-native-owner',
    parentInvocationId: 'prior-parent',
    threadId: change === 'other-thread' ? 'other-thread' : 'thread',
    userId: change === 'other-user' ? 'other-user' : 'owner',
    catId: change === 'other-cat' ? 'other-cat' : catId,
    executionKind: 'ordinary',
    providerLifecycleTracked: true,
    startedAt: 0,
  });
  if (change !== 'not-started') await store.markProviderStarted('prior-native-owner', 0);
  if (change === 'stopped') await store.recordProviderTeardown('prior-native-owner', 1);
  let priorReads = 0;
  if (change === 'unreadable')
    store.listRunningByUser = async () => {
      priorReads++;
      throw new Error('prior execution read unavailable');
    };
  return { deps, catId, store, calls: () => calls, priorReads: () => priorReads };
}

for (const route of [routeSerial, routeParallel]) {
  test(`${route.name} admits ordinary work without inventing an earlier native stop`, async (t) => {
    const f = await fixture(t, 'unconfirmed');
    const messages = await collect(route(f.deps, [f.catId], 'new task', 'owner', 'thread', { thinkingMode: 'play' }));
    assert.equal(f.calls(), 1, 'unknown historical teardown is not an admission gate');
    assert.equal(
      messages.some((message) => message.type === 'error'),
      false,
    );
    assert.equal((await f.store.get('prior-native-owner')).status, 'running');
    assert.equal((await f.store.get('prior-native-owner')).providerTeardownAt, undefined);
    assert.equal(typeof (await f.store.get('journey-1')).providerStartedAt, 'number');
    assert.equal((await f.store.get('journey-1')).status, 'succeeded');
    await f.store.recordProviderTeardown('prior-native-owner', 1);
    await collect(route(f.deps, [f.catId], 'after exact stop proof', 'owner', 'thread', { thinkingMode: 'play' }));
    assert.equal(f.calls(), 2);
    assert.equal((await f.store.get('journey-2')).status, 'succeeded');
  });
}

for (const change of ['other-user', 'other-thread', 'other-cat', 'not-started', 'stopped']) {
  test(`ordinary admission preserves the unrelated or stopped prior execution: ${change}`, async (t) => {
    const f = await fixture(t, change);
    await collect(routeSerial(f.deps, [f.catId], 'safe task', 'owner', 'thread', { thinkingMode: 'play' }));
    assert.equal(f.calls(), 1);
    assert.equal((await f.store.get('journey-1')).status, 'succeeded');
  });
}

test('the retired prior-owner lookup is not a new admission dependency', async (t) => {
  const f = await fixture(t, 'unreadable');
  await collect(routeSerial(f.deps, [f.catId], 'ordinary work', 'owner', 'thread', { thinkingMode: 'play' }));
  assert.equal(f.calls(), 1);
  assert.equal(f.priorReads(), 0);
  assert.equal((await f.store.get('journey-1')).status, 'succeeded');
  assert.equal((await f.store.get('prior-native-owner')).providerTeardownAt, undefined);
});
