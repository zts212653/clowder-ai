import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import Fastify from 'fastify';
import { TurnCustodyAdoptionRegistry } from '../src/domains/ball-custody/TurnCustodyAdoptionRegistry.ts';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { callbacksRoutes } from '../src/routes/callbacks.ts';

const root = new URL('../src/', import.meta.url);
test('canonical typed Task authority cannot restore the orphan Message-custody Redis Lua guard', () => {
  assert.equal(existsSync(new URL('domains/cats/services/stores/redis/RedisTypedWaitCustodyGuard.ts', root)), false);
  const messages = readFileSync(new URL('domains/cats/services/stores/redis/RedisMessageStore.ts', root), 'utf8');
  assert.equal(messages.includes('ASSERT_TYPED_WAIT_CUSTODY_LUA'), false);
  assert.equal(messages.includes('readRedisTypedWaitCustodyGuards'), false);
  const task = readFileSync(new URL('domains/cats/services/stores/redis/RedisTaskStore.ts', root), 'utf8');
  assert.match(task, /assertTypedWaitRegistrationInstallation/);
  assert.match(task, /runWithExclusiveRedisWatchSession/);
});

test('C7 canonical producers cannot restore a direct trigger or Message-custody retry owner', () => {
  for (const path of [
    'domains/ball-custody/A2ADispatchDispositionService.ts',
    'domains/ball-custody/WaitContinuationRetryCommitter.ts',
    'domains/ball-custody/WaitContinuationRetryPreflight.ts',
    'domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.ts',
    'domains/cats/services/stores/ports/queued-message-custody.ts',
    'infrastructure/email/ConnectorInvokeTrigger.ts',
  ])
    assert.equal(existsSync(new URL(path, root)), false, `retired direct trigger/private port: ${path}`);
  const index = readFileSync(new URL('index.ts', root), 'utf8');
  for (const name of ['QueuedMessageCustodyCoordinator', 'queueCustodyCoordinator', 'new ConnectorInvokeTrigger'])
    assert.equal(index.includes(name), false, `startup must not restore ${name}`);
  assert.match(index, /invokeTriggerHolder\.current = persistedQueueDelivery/);
  assert.match(index, /holdBallDeps\.admitManagedWake = admitManagedWake/);
  assert.match(index, /await notifyManagedWakeAdmitted\(input.threadId, input.userId\)/);
  assert.equal(index.includes('createLegacyManagedWakeAdoption'), false);
  assert.equal(index.includes('adoptLegacyManagedWake'), false);
  assert.equal(existsSync(new URL('domains/ball-custody/legacy-managed-wake-adoption.ts', root)), false);
  const exports = readFileSync(new URL('infrastructure/email/index.ts', root), 'utf8');
  assert.equal(exports.includes('ConnectorInvokeTrigger'), false);
});

test('C7 startup and processor cannot reinstate untyped Live Message-custody completion repair', () => {
  for (const path of [
    'domains/ball-custody/DispatchAdoptionAuthority.ts',
    'domains/ball-custody/DispatchReceiptService.ts',
    'domains/ball-custody/dispatch-receipt-publication.ts',
    'domains/cats/services/agents/invocation/QueueReadEvidence.ts',
    'domains/concierge/live/live-dispatch-adoption.ts',
  ])
    assert.equal(existsSync(new URL(path, root)), false, `retired untyped writer chain: ${path}`);
  const index = readFileSync(new URL('index.ts', root), 'utf8');
  for (const name of [
    'DispatchAdoptionAuthority',
    'DispatchReceiptService',
    'CoordinationTerminalRetirement',
    'liveDispatchAdoption',
    'createDispatchReceiptPublisher',
  ]) {
    assert.equal(index.includes(name), false, `startup must not construct ${name}`);
  }
  const processor = readFileSync(new URL('domains/cats/services/agents/invocation/QueueProcessor.ts', root), 'utf8');
  for (const name of ['repairDispatchSource', 'repairDispatchReceipts']) assert.equal(processor.includes(name), false);
});

const wake = (id) => ({
  kind: 'structured',
  protocol: 'hold',
  subjectKey: 'ball:thread:t',
  holderCatId: 'cat',
  sourceMessageId: id,
  taskId: `task-${id}`,
});
const identity = { invocationId: 'child', catId: 'cat', threadId: 't' };
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('production startup cannot restore the retired complete-managed-hold writer', () => {
  const index = readFileSync(new URL('index.ts', root), 'utf8');
  for (const name of [
    'ManagedHoldReceiptService',
    'ManagedHoldDispositionService',
    'ManagedHoldSourceSelection',
    'record-managed-hold-disposition',
  ]) {
    assert.equal(existsSync(new URL(`domains/ball-custody/${name}.ts`, root)), false, name);
    assert.equal(index.includes(name), false, `${name} startup reference`);
  }
  assert.equal(index.includes('createManagedHoldSettlementPublisher'), false);
});

test('pure Ball retirement/supersession observation survives without a receipt writer', () => {
  for (const name of ['managed-hold-retirement', 'managed-hold-supersession']) {
    assert.equal(existsSync(new URL(`domains/ball-custody/${name}.ts`, root)), true);
  }
});

test('actual composed callbacks refuse retired completion even if an old caller supplies its service', async (t) => {
  const registry = new InvocationRegistry();
  const auth = await registry.create('owner', 'codex', 't');
  let writes = 0;
  const app = Fastify();
  t.after(() => app.close());
  await app.register(callbacksRoutes, {
    registry,
    messageStore: new MessageStore(),
    socketManager: {
      broadcastAgentMessage() {},
      getMessages() {
        return [];
      },
    },
    evidenceStore: {
      async store() {},
      async search() {
        return [];
      },
    },
    markerQueue: { enqueue() {} },
    reflectionService: { async run() {} },
    managedHoldDispositionService: {
      async complete() {
        writes += 1;
        return { outcome: 'applied' };
      },
    },
  });
  for (const disposition of ['handled', 'completed']) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/complete-managed-hold',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: { disposition },
    });
    assert.equal(response.statusCode, 404);
  }
  assert.equal(writes, 0);
});

test('process-local bridge serializes fallible preparation and publishes only a committed exposure', async () => {
  const registry = new TurnCustodyAdoptionRegistry();
  const prepared = deferred();
  const continuePreparation = deferred();
  const publications = [];
  const unregister = registry.register('child', async (wakes) => {
    prepared.resolve();
    await continuePreparation.promise;
    return () => publications.push(...wakes.map((w) => w.sourceMessageId));
  });
  const first = registry.prepare('child', [wake('one')]);
  await prepared.promise;
  const second = registry.prepare('child', [wake('two')]);
  continuePreparation.resolve();
  (await first).abort();
  const next = await second;
  assert.deepEqual(publications, []);
  assert.deepEqual(registry.snapshot('child'), []);
  next.commit();
  next.commit();
  next.abort();
  assert.deepEqual(publications, ['two']);
  const snapshot = registry.snapshot('child');
  snapshot[0].taskId = 'forged';
  assert.equal(registry.snapshot('child')[0].taskId, 'task-two');
  await unregister();
  assert.deepEqual(registry.snapshot('child'), []);
});

test('closing an ordinary carrier refuses new work but waits for an admitted exact-child operation', async () => {
  const registry = new TurnCustodyAdoptionRegistry();
  const unregister = registry.register('child', async () => {});
  const started = deferred();
  const finish = deferred();
  let lease;
  const operation = registry.withOperation(identity, async (value) => {
    lease = value;
    assert.equal(value.matches(identity), true);
    for (const key of ['invocationId', 'threadId', 'catId'])
      assert.equal(value.matches({ ...identity, [key]: 'other' }), false);
    started.resolve();
    await finish.promise;
    return 'committed';
  });
  await started.promise;
  let closed = false;
  const closing = unregister().then(() => {
    closed = true;
  });
  assert.equal(registry.isAccepting('child'), false);
  await assert.rejects(
    registry.withOperation(identity, async () => 'new'),
    /unavailable/,
  );
  assert.equal(await registry.prepare('child', [wake('late')]), null);
  assert.equal(closed, false);
  finish.resolve();
  assert.equal(await operation, 'committed');
  await closing;
  assert.equal(lease.matches(identity), false);
  assert.equal(closed, true);
});

test('route teardown waits for a prepared exposure commit or abort without inventing a Queue owner', async () => {
  for (const disposition of ['commit', 'abort']) {
    const registry = new TurnCustodyAdoptionRegistry();
    let published = 0;
    const unregister = registry.register('child', async () => () => {
      published += 1;
    });
    const reservation = await registry.prepare('child', [wake('one'), wake('two')]);
    let closed = false;
    const closing = unregister().then(() => {
      closed = true;
    });
    await Promise.resolve();
    assert.equal(closed, false);
    reservation[disposition]();
    await closing;
    assert.equal(published, disposition === 'commit' ? 1 : 0);
    assert.equal(registry.isAccepting('child'), false);
    assert.deepEqual(registry.snapshot('child'), []);
  }
});

test('a failed preparation releases the bridge for the next exact operation', async () => {
  const registry = new TurnCustodyAdoptionRegistry();
  let attempts = 0;
  const unregister = registry.register('child', async () => {
    if (++attempts === 1) throw new Error('cannot publish');
  });
  await assert.rejects(registry.prepare('child', [wake('one')]), /cannot publish/);
  assert.deepEqual(registry.snapshot('child'), []);
  assert.equal(await registry.adopt('child', [wake('two')]), true);
  await unregister();
});
