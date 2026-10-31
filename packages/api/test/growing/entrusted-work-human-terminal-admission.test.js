import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { adaptInvocationQueue } from '../helpers/message-from-fixtures.js';
import '../helpers/setup-cat-registry.js';
import { buildActionSuccessorFence } from '../../dist/domains/ball-custody/ActionSuccessorAdmissionContract.js';
import { ActionSuccessorProjectionRetirementService } from '../../dist/domains/ball-custody/ActionSuccessorProjectionRetirementService.js';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InvocationRecordStore } from '../../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';
import { EntrustedWorkHumanTerminalService } from '../../dist/domains/growing/EntrustedWorkHumanTerminalService.js';
import { EntrustedWorkLifecycleService } from '../../dist/domains/growing/EntrustedWorkLifecycleService.js';
import { EntrustedWorkTaskExecutionService } from '../../dist/domains/growing/EntrustedWorkTaskExecutionService.js';

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test('a canceled queued Task runner cannot borrow a replacement slot before provider execution', async () => {
  const tasks = new TaskStore();
  const messages = new MessageStore();
  const lifecycle = new EntrustedWorkLifecycleService(tasks);
  const admitted = await lifecycle.admitOrResume({
    task: {
      threadId: 'thread-admission',
      title: 'Review admitted work',
      why: '',
      createdBy: 'user',
      userId: 'operator',
      ownerCatId: 'codex-sol',
    },
    admission: {
      basis: 'explicit_entrustment',
      sourceRefs: ['message:source'],
      intendedOutcome: 'Ready',
      idempotencyKey: randomUUID(),
    },
    closure: { condition: 'Owner decides', expectedSignal: 'owner_decision' },
  });
  assert.notEqual(admitted.result, 'needs_clarification');
  const taskId = admitted.ownerRef.slice('task:item:'.length);
  const lease = {
    leaseId: 'lease-admission',
    tenantScope: 'operator',
    subjectRef: `subject:task:${taskId}`,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: ['codex-sol'],
    holderThreadId: 'thread-admission',
    generation: 2,
    status: 'active',
    dispatchDeliveryState: 'pending',
    dispatchId: 'dispatch-admission',
    terminalPredicate: {
      kind: 'task_done',
      subjectRef: `subject:task:${taskId}`,
      digest: 'predicate-admission',
    },
  };
  const leaseStore = {
    getByIdentity: async () => ({ ...lease }),
    preflight: async () => ({
      ok: lease.status === 'active',
      reason: lease.status === 'active' ? 'active' : 'subject_terminal',
    }),
    preflightOutput: async () => ({
      ok: lease.status === 'active',
      reason: lease.status === 'active' ? 'active' : 'subject_terminal',
    }),
    commitOutcome: async () => ({ outcome: 'subject_terminal' }),
  };
  const records = new InvocationRecordStore();
  const tracker = new InvocationTracker();
  const queue = adaptInvocationQueue(new InvocationQueue());
  const beforeRunning = deferred();
  const releaseRunning = deferred();
  let parentId;
  const queueRecords = {
    create: async (input) => {
      const result = records.create(input);
      parentId = result.invocationId;
      return result;
    },
    get: (id) => records.get(id),
    update: async (id, input) => {
      if (input.status === 'running') {
        beforeRunning.resolve();
        await releaseRunning.promise;
      }
      return records.update(id, input);
    },
  };
  let providerCalls = 0;
  let passedSignal;
  const processor = new QueueProcessor({
    queue,
    actionSuccessorLeaseStore: leaseStore,
    invocationTracker: tracker,
    invocationRecordStore: queueRecords,
    router: {
      routeExecution: async function* (...args) {
        passedSignal = args[6]?.signalForCat?.('codex-sol') ?? args[6]?.signal;
        if (passedSignal?.aborted) return;
        providerCalls += 1;
        yield { type: 'done', catId: 'codex-sol', timestamp: Date.now() };
      },
      ackCollectedCursors: async () => {},
    },
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    messageStore: messages,
    log: { info() {}, warn() {}, error() {} },
  });
  const execution = new EntrustedWorkTaskExecutionService({
    leaseStore,
    invocationRecords: records,
    turnExecutions: { listRunningByUser: async () => [] },
    tracker,
  });
  const retirement = new ActionSuccessorProjectionRetirementService({
    invocationQueue: queue,
    queueCustodyCoordinator: { retireActionSuccessorFence: async () => null },
    taskStore: tasks,
    publishQueue: async () => {},
  });
  let runnerOutcome;
  const human = new EntrustedWorkHumanTerminalService({
    tasks,
    messages,
    lifecycle: {
      close: async (command) => {
        const closed = await lifecycle.close(command);
        lease.status = 'completed';
        await retirement.retire(lease);
        return closed;
      },
    },
    execution: {
      inspect: async (task) => {
        const snapshot = await execution.inspect(task);
        assert.equal(snapshot.projection.state, 'queued');
        lease.dispatchDeliveryState = 'delivered';
        queue.enqueue({
          kind: 'private_input',
          ownerAuthProvenance: 'unknown',
          threadId: 'thread-admission',
          userId: 'operator',
          content: 'Continue this Task',
          source: 'agent',
          targetCats: ['codex-sol'],
          intent: 'execute',
          autoExecute: false,
          actionSuccessorFence: buildActionSuccessorFence(lease, lease.dispatchId),
        });
        const entry = await claimOnlyTarget(queue, 'thread-admission');
        assert.ok(entry);
        runnerOutcome = processor.executeEntry(entry).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await beforeRunning.promise;
        return snapshot;
      },
      stopAfterTerminal: (...args) => execution.stopAfterTerminal(...args),
    },
  });

  const result = await human.decide({
    taskId,
    userId: 'operator',
    input: {
      v: 1,
      decisionId: randomUUID(),
      expectedRevision: 1,
      decision: { state: 'cancelled', reason: 'No longer needed' },
    },
  });
  const controller = tracker.getController('thread-admission', 'codex-sol');
  assert.ok(controller, 'the real tracker must already own the exact queued parent');
  assert.equal(result.execution.stop.state, 'stopped');
  assert.deepEqual(result.execution.stop.executionRefs, [parentId]);
  assert.equal(records.get(parentId)?.status, 'queued');
  assert.equal(controller.signal.aborted, true);
  assert.equal(
    queue.list('thread-admission', 'operator').length,
    1,
    'terminal retirement must not steal the runner’s reversible claim',
  );

  const replacement = records.create({
    threadId: 'thread-admission',
    userId: 'operator',
    targetCats: ['codex-sol'],
    intent: 'execute',
    idempotencyKey: randomUUID(),
    actionLeaseCarrier: { kind: 'none' },
  });
  records.update(replacement.invocationId, { status: 'running', expectedStatus: 'queued' });
  const replacementBatch = tracker.tryStartThreadAll(
    'thread-admission',
    ['codex-sol'],
    'operator',
    replacement.invocationId,
  );
  assert.ok(replacementBatch, 'the canceled tombstone must admit a new invocation');
  const replacementController = tracker.getController('thread-admission', 'codex-sol');
  assert.ok(replacementController);
  assert.equal(replacementController.signal.aborted, false);

  releaseRunning.resolve();
  const outcome = await runnerOutcome;
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.value?.status, 'canceled_by_user');
  assert.equal(queue.list('thread-admission', 'operator').length, 0, 'the canceled runner retires its own claim');
  assert.equal(providerCalls, 0, 'cancel must fence the pre-running admitted carrier before provider execution');
  assert.notEqual(passedSignal, replacementController.signal, 'the old runner cannot inherit its replacement signal');
  assert.equal(replacementController.signal.aborted, false);
  assert.equal(tracker.getExecutionId('thread-admission', 'codex-sol'), replacement.invocationId);
  assert.equal(records.get(parentId)?.status, 'canceled');
});

test('a queued runner keeps its original signal when replacement happens inside the route boundary', async () => {
  const queue = adaptInvocationQueue(new InvocationQueue());
  const tracker = new InvocationTracker();
  const records = new InvocationRecordStore();
  const entry = queue.enqueue({
    kind: 'private_input',
    ownerAuthProvenance: 'unknown',
    threadId: 'thread-route-signal',
    userId: 'operator',
    content: 'Continue ordinary work',
    source: 'user',
    targetCats: ['codex-sol'],
    intent: 'execute',
    autoExecute: false,
  }).entry;
  const processing = await claimOnlyTarget(queue, 'thread-route-signal');
  assert.equal(processing?.id, entry.id);

  let providerCalls = 0;
  let originalSignal;
  let passedSignal;
  let replacementController;
  let replacementId;
  const processor = new QueueProcessor({
    queue,
    invocationTracker: tracker,
    invocationRecordStore: records,
    router: {
      routeExecution: async function* (...args) {
        const parentId = tracker.getExecutionId('thread-route-signal', 'codex-sol');
        assert.ok(parentId);
        originalSignal = tracker.getController('thread-route-signal', 'codex-sol')?.signal;
        const stopped = tracker.cancelExact('thread-route-signal', 'codex-sol', parentId, 'operator', 'user_cancel');
        assert.equal(stopped.cancelled, true);
        const replacement = records.create({
          threadId: 'thread-route-signal',
          userId: 'operator',
          targetCats: ['codex-sol'],
          intent: 'execute',
          idempotencyKey: randomUUID(),
          actionLeaseCarrier: { kind: 'none' },
        });
        replacementId = replacement.invocationId;
        records.update(replacementId, { status: 'running', expectedStatus: 'queued' });
        assert.ok(tracker.tryStartThreadAll('thread-route-signal', ['codex-sol'], 'operator', replacementId));
        replacementController = tracker.getController('thread-route-signal', 'codex-sol');
        passedSignal = args[6]?.signalForCat?.('codex-sol') ?? args[6]?.signal;
        if (passedSignal?.aborted) return;
        providerCalls += 1;
        yield { type: 'done', catId: 'codex-sol', timestamp: Date.now() };
      },
      ackCollectedCursors: async () => {},
    },
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    messageStore: new MessageStore(),
    log: { info() {}, warn() {}, error() {} },
  });

  const result = await processor.executeEntry(processing);
  assert.equal(result.status, 'canceled_by_user');
  assert.equal(providerCalls, 0);
  assert.equal(passedSignal, originalSignal);
  assert.equal(passedSignal?.aborted, true);
  assert.notEqual(passedSignal, replacementController?.signal);
  assert.equal(replacementController?.signal.aborted, false);
  assert.equal(tracker.getExecutionId('thread-route-signal', 'codex-sol'), replacementId);
});

async function claimOnlyTarget(queue, threadId) {
  const entry = queue.list(threadId, 'operator')[0];
  assert.ok(entry);
  const claimed = await queue.markProcessingGroupAcrossUsersDurable(
    threadId,
    { entryId: entry.id, targetCats: ['codex-sol'] },
    [entry.id],
  );
  return claimed?.entry;
}
