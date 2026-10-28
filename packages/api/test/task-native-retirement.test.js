import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionSuccessorDispatchRecovery } from '../dist/domains/ball-custody/ActionSuccessorDispatchRecovery.js';
import { ActionSuccessorRecoverySweep } from '../dist/domains/ball-custody/ActionSuccessorRecoverySweep.js';
import { canonicalizeActionTerminalPredicate } from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import { LegacyTaskExecutionResolver } from '../dist/domains/ball-custody/LegacyTaskExecution.js';
import { buildCallbackPostMessageIdempotencyKey } from '../dist/domains/cats/services/agents/routing/callback-message-idempotency.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';

function fixture() {
  const tasks = new TaskStore(),
    messages = new MessageStore(),
    turns = new InMemoryTurnExecutionStore();
  const task = tasks.create({
    threadId: 'home',
    userId: 'task-user',
    ownerCatId: 'codex',
    title: 'Legacy work',
    createdBy: 'sonnet',
  });
  const legacy = { ...task };
  delete legacy.ownerRevision;
  const lease = {
    leaseId: 'historical',
    tenantScope: 'task-user',
    subjectRef: `subject:task:${task.id}`,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: ['codex'],
    holderThreadId: 'home',
    predecessorCatId: 'sonnet',
    predecessorThreadId: 'home',
    dispatchId: 'post:old-source',
    generation: 1,
    status: 'active',
    returnTransitions: [],
    holderOutcomes: {},
    evidenceRefs: [],
    revision: 1,
    terminalPredicate: canonicalizeActionTerminalPredicate({
      actionFamily: 'implement',
      subjectRef: `subject:task:${task.id}`,
      predicate: { kind: 'task_done' },
    }),
  };
  return { tasks, messages, turns, task, legacy, lease };
}

test('legacy lease is only an execution locator: terminal parent/status cannot prove the exact provider stopped', async () => {
  const f = fixture();
  const source = f.messages.appendIdempotent({
    userId: 'task-user',
    threadId: 'home',
    from: { kind: 'agent', catId: 'sonnet' },
    origin: 'callback',
    content: 'Original handoff',
    mentions: ['codex'],
    timestamp: 1,
    deliveryStatus: 'queued',
    idempotencyKey: buildCallbackPostMessageIdempotencyKey('sonnet', 'old-source'),
  }).message;
  f.messages.markDelivered(source.id, 1);
  const resolver = new LegacyTaskExecutionResolver({
    leases: {
      async getByIdentity() {
        return f.lease;
      },
    },
    messages: f.messages,
    turns: f.turns,
  });
  f.turns.createRunning({
    invocationId: 'exact-child',
    parentInvocationId: 'parent',
    catId: 'codex',
    threadId: 'home',
    userId: 'task-user',
    executionKind: 'ordinary',
    causal: { triggerMessageId: source.id },
    startedAt: 2,
  });
  f.turns.transitionTerminal('exact-child', { status: 'succeeded', endedAt: 3 });
  const unknownStop = await resolver.resolve(f.legacy);
  assert.equal(unknownStop.kind, 'execution');
  assert.equal(unknownStop.execution.invocationId, 'exact-child');
  f.turns.recordProviderTeardown('exact-child', 4);
  assert.deepEqual(await resolver.resolve(f.legacy), { kind: 'idle' });
  f.messages.softDelete(source.id, 'task-user');
  assert.deepEqual(await resolver.resolve(f.legacy), { kind: 'unknown' });
});

test('retired ordinary return and dispatch recovery keep history inert without transport or settlement', async () => {
  const f = fixture();
  let writes = 0,
    wakes = 0;
  const forbidden = async () => {
    writes++;
    throw new Error('retired lease must remain read-only');
  };
  const returned = {
    ...f.lease,
    status: 'active',
    predecessorCatId: 'sonnet',
    returnDeliveryState: 'pending',
    returnDeliverySlaUntil: 1,
  };
  const original = structuredClone(returned);
  const sweep = new ActionSuccessorRecoverySweep({
    tasks: f.tasks,
    leaseStore: {
      async listPendingReturns() {
        return [returned];
      },
      recordReturnDeliveryAttempt: forbidden,
      markReturnDelivered: forbidden,
    },
    async deliverReturnCarrier() {
      wakes++;
      return { outcome: 'enqueued' };
    },
  });
  const stats = await sweep.runOnce();
  assert.equal(stats.delivered, 0);
  assert.equal(stats.pending, 0);
  const dispatch = new ActionSuccessorDispatchRecovery({
    tasks: f.tasks,
    leaseStore: {},
    truthResolver: { resolveFreshness: forbidden },
    loadProposal: forbidden,
    loadOwnerAuthProvenance: forbidden,
    recordProposalDelivery: forbidden,
    deliver: forbidden,
  });
  assert.deepEqual(await dispatch.recover(f.lease), { outcome: 'ignored' });
  assert.equal(writes, 0);
  assert.equal(wakes, 0);
  assert.deepEqual(returned, original);
});
