import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import Fastify from 'fastify';
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

test('retired process-local adoption bridge cannot return as a second lifecycle owner', () => {
  assert.equal(existsSync(new URL('domains/ball-custody/TurnCustodyAdoptionRegistry.ts', root)), false);
});
