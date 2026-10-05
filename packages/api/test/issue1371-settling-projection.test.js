import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import Fastify from 'fastify';
import { realDeps, realPresenceSource, startRunningRecordWithDraft } from './helpers/f297-presence-fixtures.js';

const { queueRoutes } = await import('../dist/routes/queue.js');
const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { projectInvocationSettlement } = await import(
  '../dist/domains/cats/services/agents/invocation/InvocationSettlementProjection.js'
);
const { observeCliExecutionProcess } = await import('../dist/utils/CliExecutionObservation.js');
const { recordCodexAppServerLifecycle, clearCodexAppServerLifecycle } = await import(
  '../dist/domains/cats/services/agents/providers/CodexAppServerLifecycleRegistry.js'
);

test('canonical projection identifies finished primary while exact same-parent guard is running', async () => {
  const deps = await realDeps();
  const scope = { threadId: 'settling-thread', userId: 'alice', catId: 'opus5' };
  const parentInvocationId = await startRunningRecordWithDraft(deps, scope);
  deps.invocationTracker.start(scope.threadId, scope.catId, scope.userId, [scope.catId], parentInvocationId);
  await deps.turnExecutionStore.createRunning({
    ...scope,
    parentInvocationId,
    invocationId: 'primary',
    executionKind: 'ordinary',
    startedAt: 100,
  });
  await deps.turnExecutionStore.transitionTerminal('primary', { status: 'succeeded', endedAt: 200 });
  await deps.turnExecutionStore.createRunning({
    ...scope,
    parentInvocationId,
    invocationId: 'guard',
    executionKind: 'routing_guard',
    startedAt: 201,
  });
  const { service } = await realPresenceSource(deps);
  assert.equal(
    (await service.resolveActiveInvocations(scope.threadId, scope.userId))[0].settlement,
    undefined,
    'old running ledger alone cannot certify settling',
  );
  const nativeGuard = new EventEmitter();
  observeCliExecutionProcess(nativeGuard, { ...scope, executionId: parentInvocationId, invocationId: 'guard' });
  const slots = await service.resolveActiveInvocations(scope.threadId, scope.userId);
  assert.equal(slots[0].turnInvocationId, 'guard');
  assert.deepEqual(slots[0].settlement, { activeTurnInvocationId: 'guard', completedTurnInvocationIds: ['primary'] });
  const app = Fastify();
  await app.register(queueRoutes, {
    threadStore: { get: () => ({ id: scope.threadId, createdBy: scope.userId }) },
    invocationQueue: new InvocationQueue(),
    invocationTracker: deps.invocationTracker,
    invocationRecordStore: deps.recordStore,
    draftStore: deps.draftStore,
    turnExecutionStore: deps.turnExecutionStore,
    queueProcessor: { isPaused: () => false, getPauseReason: () => undefined },
    socketManager: { emitToUser() {}, broadcastAgentMessage() {} },
  });
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${url}/api/threads/${scope.threadId}/queue`, {
      headers: { 'x-cat-cafe-user': scope.userId },
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).activeInvocations[0].settlement, slots[0].settlement);
  } finally {
    await app.close();
  }
  await deps.turnExecutionStore.transitionTerminal('guard', {
    status: 'failed',
    endedAt: 300,
    terminalReason: 'fixture',
  });
  const after = await service.resolveActiveInvocations(scope.threadId, scope.userId);
  assert.ok(
    after.every((slot) => slot.settlement === undefined),
    'finished guard must not indefinitely hide recovery',
  );
  nativeGuard.emit('exit', 0, null);
});

test('settlement cannot borrow foreign scope, unrelated new turn, failed child or later terminal', () => {
  const scope = { threadId: 't', userId: 'u', catId: 'opus5', executionId: 'p', turnInvocationId: 'g' };
  const primary = {
    invocationId: 'c',
    parentInvocationId: 'p',
    threadId: 't',
    userId: 'u',
    catId: 'opus5',
    status: 'succeeded',
    endedAt: 2,
  };
  const guard = { ...primary, invocationId: 'g', status: 'running', executionKind: 'routing_guard', startedAt: 3 };
  const native = new EventEmitter();
  observeCliExecutionProcess(native, { ...scope, invocationId: 'g' });
  assert.deepEqual(projectInvocationSettlement(scope, [primary, guard]), {
    activeTurnInvocationId: 'g',
    completedTurnInvocationIds: ['c'],
  });
  for (const patch of [
    { userId: 'other' },
    { catId: 'other' },
    { threadId: 'other' },
    { parentInvocationId: 'other' },
    { status: 'failed' },
    { endedAt: 4 },
  ]) {
    assert.equal(projectInvocationSettlement(scope, [{ ...primary, ...patch }, guard]), undefined);
  }
  assert.equal(projectInvocationSettlement(scope, [primary, { ...guard, executionKind: 'ordinary' }]), undefined);
  assert.equal(projectInvocationSettlement(scope, [primary, { ...guard, status: 'succeeded' }]), undefined);
  native.emit('exit', 0, null);
  assert.equal(
    projectInvocationSettlement(scope, [primary, guard]),
    undefined,
    'an exited native guard is not active settlement proof',
  );
});

test('Codex auxiliary settlement uses exact child protocol evidence, never a parent-only or previous-child snapshot', () => {
  const scope = {
    threadId: 'protocol-t',
    userId: 'u',
    catId: 'codex-sol',
    executionId: 'protocol-p',
    turnInvocationId: 'protocol-g',
  };
  const primary = {
    invocationId: 'protocol-c',
    parentInvocationId: scope.executionId,
    threadId: scope.threadId,
    userId: scope.userId,
    catId: scope.catId,
    status: 'succeeded',
    endedAt: 2,
  };
  const guard = {
    ...primary,
    invocationId: scope.turnInvocationId,
    status: 'running',
    executionKind: 'routing_guard',
    startedAt: 3,
  };
  const lifecycle = {
    stage: 'active',
    lastActivityAt: Date.now(),
    recoveryAttempt: 0,
    turnStartSent: true,
    turnAccepted: true,
    itemObserved: true,
    toolSurfaceObserved: false,
  };
  const publish = (childInvocationId, stage = 'active') =>
    recordCodexAppServerLifecycle({
      threadId: scope.threadId,
      catId: scope.catId,
      invocationId: scope.executionId,
      childInvocationId,
      lifecycle: { ...lifecycle, stage },
    });
  try {
    publish(undefined);
    assert.equal(projectInvocationSettlement(scope, [primary, guard]), undefined);
    publish('old-child');
    assert.equal(projectInvocationSettlement(scope, [primary, guard]), undefined);
    publish(scope.turnInvocationId);
    assert.deepEqual(projectInvocationSettlement(scope, [primary, guard])?.completedTurnInvocationIds, ['protocol-c']);
    publish(scope.turnInvocationId, 'closed');
    assert.equal(projectInvocationSettlement(scope, [primary, guard]), undefined);
    publish(scope.turnInvocationId);
    const exitedGuard = new EventEmitter();
    observeCliExecutionProcess(exitedGuard, { ...scope, invocationId: scope.turnInvocationId });
    exitedGuard.emit('exit', 0, null);
    assert.equal(
      projectInvocationSettlement(scope, [primary, guard]),
      undefined,
      'native exit vetoes stale protocol activity',
    );
  } finally {
    clearCodexAppServerLifecycle(scope.threadId, scope.catId, scope.executionId);
  }
});
