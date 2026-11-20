import assert from 'node:assert/strict';
import { test } from 'node:test';

const { InMemoryTurnExecutionStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
);
const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { toolExecutionPolicyDenial } = await import(
  '../dist/domains/cats/services/agents/invocation/tool-execution-policy.js'
);
const { selectRecentStops } = await import(
  '../dist/domains/cats/services/agents/invocation/thread-execution-situation.js'
);
const { createActiveExecutionService } = await import(
  '../dist/domains/cats/services/agents/invocation/active-execution-service.js'
);

test('F338: maintenance has its own durable principal, no callback grant, and cannot supersede member work evidence', async () => {
  const store = new InMemoryTurnExecutionStore();
  const registry = new InvocationRegistry({ turnExecutionStore: store });
  const policy = { mode: 'callback_allowlist', allowedCallbackRoutes: [] };
  const principal = await registry.create(
    'owner',
    'sonnet',
    'thread',
    'maintenance-source',
    undefined,
    policy,
    undefined,
    'strict',
  );
  await store.createRunning({
    ...principal,
    parentInvocationId: 'maintenance-source',
    userId: 'owner',
    catId: 'sonnet',
    threadId: 'thread',
    executionKind: 'cache_retention',
    startedAt: 200,
  });
  const verified = await registry.verify(principal.invocationId, principal.callbackToken);
  assert.equal(verified.ok, true);
  assert.ok(toolExecutionPolicyDenial(verified.record.toolExecutionPolicy, 'POST /api/callbacks/post-message'));
  assert.ok(toolExecutionPolicyDenial(verified.record.toolExecutionPolicy, 'GET /api/callbacks/thread-context'));
  assert.equal(
    await store.hasMemberTurnStartedAfter({ userId: 'owner', catId: 'sonnet', threadId: 'thread', startedAfter: 100 }),
    false,
  );
  const active = createActiveExecutionService({
    turnExecutionStore: store,
    invocationTracker: { getActiveForUser: () => [] },
    log: { info() {}, warn() {} },
  });
  assert.deepEqual(await active.listRunningChildExecutions('owner'), [], 'maintenance must not look like member work');
  await store.transitionTerminal(principal.invocationId, {
    status: 'failed',
    endedAt: 300,
    terminalReason: 'cache_retention_sample_failed',
  });
  const maintenance = await store.get(principal.invocationId);
  assert.deepEqual(selectRecentStops([maintenance], 301), [], 'silent maintenance is not a recent stopped work turn');
  await registry.commitTerminal({
    invocationId: principal.invocationId,
    disposition: 'failed',
    endedAt: 300,
    endReason: 'sample_failed',
  });
  assert.equal((await registry.verify(principal.invocationId, principal.callbackToken)).ok, false);
});

test('F338: interrupted cache maintenance never owes a member continuation', async () => {
  const store = new InMemoryTurnExecutionStore();
  for (const terminalReason of ['host_sleep', 'restart_shutdown']) {
    await store.createRunning({
      invocationId: terminalReason,
      parentInvocationId: 'probe',
      userId: 'owner',
      catId: 'sonnet',
      threadId: 'thread',
      executionKind: 'cache_retention',
      startedAt: 100,
    });
    await store.transitionTerminal(terminalReason, { status: 'failed', endedAt: 200, terminalReason });
  }
  assert.deepEqual(await store.listOwedContinuations(), []);
});
