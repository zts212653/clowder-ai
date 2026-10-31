import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TaskItem } from '@cat-cafe/shared';
import type { ActionSuccessorLease } from '../../src/domains/ball-custody/action-successor-state-machine.js';
import type { InvocationRecord } from '../../src/domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { TurnExecutionRecord } from '../../src/domains/cats/services/stores/ports/TurnExecutionStore.js';
import { EntrustedWorkTaskExecutionService } from '../../src/domains/growing/EntrustedWorkTaskExecutionService.js';

const now = 1_791_772_100_000;

function task(id: string, ownerCatId: string | null = 'codex-sol'): TaskItem {
  return {
    id,
    kind: 'work',
    threadId: 'thread-shared',
    title: id,
    why: '',
    status: 'doing',
    ownerCatId,
    userId: 'operator',
    createdBy: 'user',
    createdAt: 1,
    updatedAt: 1,
    entrustedWork: {
      revision: 3,
      admission: {
        basis: 'explicit_entrustment',
        sourceRefs: ['message:source'],
        idempotencyKey: `${id}#custody`,
        receiptRef: `task:receipt:${id}:1`,
        admittedAt: 1,
      },
      intendedOutcome: id,
      time: {},
      artifactRefs: [],
      closure: { condition: 'done', expectedSignal: 'done', state: 'open', evidenceRefs: [] },
    },
  } as TaskItem;
}

function lease(taskId: string, input: Partial<ActionSuccessorLease> = {}): ActionSuccessorLease {
  return {
    leaseId: `lease-${taskId}`,
    tenantScope: 'operator',
    subjectRef: `subject:task:${taskId}`,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: ['codex-sol'],
    dispatchId: `dispatch-${taskId}`,
    claimOrigin: 'existing_standing',
    holderThreadId: 'thread-shared',
    issuerStandingEvidenceRef: `task:${taskId}`,
    generation: 2,
    status: 'completed',
    holderOutcomes: {},
    completionCandidates: {},
    evidenceRefs: [],
    returnTransitions: [],
    replacementTransitions: [],
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    terminalPredicateState: { kind: 'predicate_backed' },
    terminalPredicate: {
      kind: 'task_done',
      subjectRef: `subject:task:${taskId}`,
      identityKey: `task_done\u001fsubject:task:${taskId}`,
      freshnessKey: `task:${taskId}`,
      digest: `task_done:${taskId}`,
    },
    ...input,
  } as ActionSuccessorLease;
}

function parentRecord(
  id: string,
  leaseId: string,
  catId: string,
  status: InvocationRecord['status'] = 'running',
  generation = 2,
): InvocationRecord {
  return {
    id,
    threadId: 'thread-shared',
    userId: 'operator',
    userMessageId: 'message:carrier',
    targetCats: [catId as InvocationRecord['targetCats'][number]],
    intent: 'execute',
    status,
    idempotencyKey: id,
    actionLeaseCarrier: { kind: 'action_successor', leaseId, generation },
    createdAt: 1,
    updatedAt: 1,
  };
}

function childRecord(parentInvocationId: string, catId = 'codex-sol'): TurnExecutionRecord {
  return {
    invocationId: `child-${parentInvocationId}`,
    parentInvocationId,
    threadId: 'thread-shared',
    userId: 'operator',
    catId: catId as TurnExecutionRecord['catId'],
    executionKind: 'ordinary',
    startedAt: 2,
    status: 'running',
  };
}

function service(input: {
  taskLease: ActionSuccessorLease | null;
  runningParents?: InvocationRecord[];
  runningChildren?: TurnExecutionRecord[];
  parentsById?: Record<string, InvocationRecord>;
  tracker?: {
    getExecutionId?(threadId: string, catId: string): string | undefined;
    cancelExact(
      threadId: string,
      catId: string,
      executionId: string,
      userId: string,
      reason: string,
    ): {
      state:
        | 'cancelled'
        | 'already_cancelled'
        | 'not_found'
        | 'user_mismatch'
        | 'execution_mismatch'
        | 'cancellation_conflict';
      cancelled: boolean;
      catIds: string[];
      executionIds?: string[];
    };
  };
}) {
  return new EntrustedWorkTaskExecutionService({
    now: () => now,
    leaseStore: { getByIdentity: async () => input.taskLease },
    invocationRecords: {
      listRunningByThread: async () => input.runningParents ?? [],
      get: async (id) => input.parentsById?.[id] ?? null,
    },
    turnExecutions: { listRunningByUser: async () => input.runningChildren ?? [] },
    ...(input.tracker ? { tracker: input.tracker } : {}),
  });
}

describe('F310 exact Task execution truth', () => {
  test('same Thread activity for another Task does not negate this Task binding being idle', async () => {
    const taskA = task('task-a');
    const other = parentRecord('parent-b', 'lease-task-b', 'other-cat');
    const projection = await service({ taskLease: lease('task-a'), runningParents: [other] }).read(taskA);

    assert.equal(projection.scope, 'task_binding');
    assert.equal(projection.state, 'idle');
    assert.equal(projection.canConfirmSatisfied, true);
  });

  test('a running exact child keeps the Task running after its parent record became terminal', async () => {
    const parent = parentRecord('parent-a', 'lease-task-a', 'codex-sol', 'succeeded');
    const projection = await service({
      taskLease: lease('task-a', { status: 'active', dispatchDeliveryState: 'delivered' }),
      runningParents: [],
      runningChildren: [childRecord(parent.id)],
      parentsById: { [parent.id]: parent },
    }).read(task('task-a'));

    assert.equal(projection.state, 'running');
    assert.equal(projection.reasonCode, 'exact_child_running');
    assert.deepEqual(projection.execution, {
      parentInvocationId: 'parent-a',
      childInvocationId: 'child-parent-a',
    });
  });

  test('pending exact dispatch is queued while a delivered carrier without execution stays unknown', async () => {
    const pending = await service({
      taskLease: lease('task-a', { status: 'active', dispatchDeliveryState: 'pending' }),
    }).read(task('task-a'));
    assert.equal(pending.state, 'queued');

    const delivered = await service({
      taskLease: lease('task-a', { status: 'active', dispatchDeliveryState: 'delivered' }),
    }).read(task('task-a'));
    assert.equal(delivered.state, 'unknown');
    assert.equal(delivered.reasonCode, 'carrier_state_unresolved');
  });

  test('cancel aborts only the exact Task carrier and never another Task in the same Thread', async () => {
    const cancelled: Array<{ threadId: string; catId: string; executionId: string | undefined }> = [];
    const tracker = {
      cancelExact: (threadId: string, catId: string, executionId: string) => {
        cancelled.push({ threadId, catId, executionId });
        return { state: 'cancelled' as const, cancelled: true, catIds: [catId], executionIds: [executionId] };
      },
    };
    const execution = service({
      taskLease: lease('task-a', { status: 'active', dispatchDeliveryState: 'delivered' }),
      runningParents: [
        parentRecord('parent-a', 'lease-task-a', 'codex-sol'),
        parentRecord('parent-b', 'lease-task-b', 'other-cat'),
      ],
      tracker,
    });
    const inspection = await execution.inspect(task('task-a'));
    const stopped = await execution.stopAfterTerminal(task('task-a'), inspection);

    assert.equal(stopped.state, 'stopped');
    assert.deepEqual(cancelled, [{ threadId: 'thread-shared', catId: 'codex-sol', executionId: 'parent-a' }]);
  });

  test('missing owner sources and ambiguous exact carriers fail closed to unknown', async () => {
    const noLease = await service({ taskLease: null }).read(task('task-a'));
    assert.equal(noLease.state, 'unknown');
    assert.equal(noLease.reasonCode, 'binding_missing_for_assignee');

    const ambiguous = await service({
      taskLease: lease('task-a', { status: 'active', dispatchDeliveryState: 'delivered' }),
      runningParents: [
        parentRecord('parent-a-1', 'lease-task-a', 'codex-sol'),
        parentRecord('parent-a-2', 'lease-task-a', 'codex-sol'),
      ],
    }).read(task('task-a'));
    assert.equal(ambiguous.state, 'unknown');
    assert.equal(ambiguous.reasonCode, 'ambiguous_task_execution');
  });

  test('an unavailable binding source is unknown even when no Thread execution is visible', async () => {
    const projection = await new EntrustedWorkTaskExecutionService({ now: () => now }).read(task('task-a'));
    assert.equal(projection.state, 'unknown');
    assert.equal(projection.reasonCode, 'binding_source_unavailable');
  });

  test('an authoritative no-lease read is idle only for an unassigned Task', async () => {
    const projection = await service({ taskLease: null }).read(task('task-unassigned', null));
    assert.equal(projection.state, 'idle');
    assert.equal(projection.reasonCode, 'unassigned_without_binding');
  });

  test('a replaced tracker owner is reported not-stopped and is never cancelled by thread/cat coincidence', async () => {
    let cancelCalls = 0;
    const tracker = {
      cancelExact: () => {
        cancelCalls += 1;
        return {
          state: 'execution_mismatch' as const,
          cancelled: false,
          catIds: [],
          executionIds: [],
        };
      },
    };
    const execution = service({
      taskLease: lease('task-a', { status: 'active', dispatchDeliveryState: 'delivered' }),
      runningParents: [parentRecord('parent-a', 'lease-task-a', 'codex-sol')],
      tracker,
    });
    const inspection = await execution.inspect(task('task-a'));
    const stopped = await execution.stopAfterTerminal(task('task-a'), inspection);
    assert.equal(stopped.state, 'not_stopped');
    assert.equal(stopped.reasonCode, 'exact_tracker_execution_missing');
    assert.equal(cancelCalls, 1, 'the exact atomic fence owns the comparison and refuses the replacement');
  });

  test('closing a queued Task reports prevented-start only after the exact lease is terminal', async () => {
    let currentLease: ActionSuccessorLease | null = lease('task-a', {
      status: 'active',
      dispatchDeliveryState: 'pending',
    });
    const execution = new EntrustedWorkTaskExecutionService({
      now: () => now,
      leaseStore: { getByIdentity: async () => currentLease },
      invocationRecords: { listRunningByThread: async () => [], get: async () => null },
      turnExecutions: { listRunningByUser: async () => [] },
      tracker: {
        getExecutionId: () => undefined,
        cancelExact: () => ({ state: 'not_found', cancelled: false, catIds: [], executionIds: [] }),
      },
    });
    const inspection = await execution.inspect(task('task-a'));
    assert.equal(inspection.projection.state, 'queued');
    currentLease = lease('task-a', { status: 'completed', dispatchDeliveryState: 'pending' });
    const stopped = await execution.stopAfterTerminal(task('task-a'), inspection);
    assert.equal(stopped.state, 'prevented_start');
    assert.equal(stopped.reasonCode, 'queued_binding_retired');

    currentLease = null;
    const missing = await execution.stopAfterTerminal(task('task-a'), inspection);
    assert.equal(missing.state, 'unknown');
    assert.equal(missing.reasonCode, 'task_execution_unknown');

    currentLease = lease('task-a', { generation: 3, status: 'completed', dispatchDeliveryState: 'pending' });
    const replaced = await execution.stopAfterTerminal(task('task-a'), inspection);
    assert.equal(replaced.state, 'not_stopped');
    assert.equal(replaced.reasonCode, 'exact_tracker_execution_missing');
  });

  test('an older generation under the same lease cannot become current Task execution authority', async () => {
    const projection = await service({
      taskLease: lease('task-a', { generation: 3, status: 'completed' }),
      runningParents: [parentRecord('parent-old', 'lease-task-a', 'codex-sol', 'running', 1)],
    }).read(task('task-a'));
    assert.equal(projection.state, 'unknown');
    assert.equal(projection.reasonCode, 'carrier_generation_mismatch');
    assert.equal(projection.binding?.generation, 3);
  });

  test('a same-lease carrier for another cat cannot be projected or stopped as this Task', async () => {
    const projection = await service({
      taskLease: lease('task-a', { status: 'active', dispatchDeliveryState: 'delivered' }),
      runningParents: [parentRecord('parent-other-cat', 'lease-task-a', 'other-cat')],
    }).read(task('task-a'));
    assert.equal(projection.state, 'unknown');
    assert.equal(projection.reasonCode, 'binding_task_mismatch');
  });

  test('a child for another cat cannot borrow the exact parent carrier', async () => {
    const parent = parentRecord('parent-a', 'lease-task-a', 'codex-sol', 'succeeded');
    const projection = await service({
      taskLease: lease('task-a', { status: 'active', dispatchDeliveryState: 'delivered' }),
      runningChildren: [childRecord(parent.id, 'other-cat')],
      parentsById: { [parent.id]: parent },
    }).read(task('task-a'));
    assert.equal(projection.state, 'unknown');
    assert.equal(projection.reasonCode, 'binding_task_mismatch');
  });

  test('a lease whose terminal predicate names another Task is not this Task binding', async () => {
    const projection = await service({
      taskLease: lease('task-a', {
        terminalPredicate: {
          kind: 'task_done',
          subjectRef: 'subject:task:task-other',
          identityKey: 'task_done\u001fsubject:task:task-other',
          freshnessKey: 'task:task-other',
          digest: 'task_done:task-other',
        },
      }),
    }).read(task('task-a'));
    assert.equal(projection.state, 'unknown');
    assert.equal(projection.reasonCode, 'binding_task_mismatch');
  });
});
