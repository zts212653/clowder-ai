import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskItem } from '@cat-cafe/shared';
import type { ActionSuccessorLease } from '../../src/domains/ball-custody/action-successor-state-machine.js';
import { EntrustedWorkTaskExecutionService } from '../../src/domains/growing/EntrustedWorkTaskExecutionService.js';

const taskId = 'task-parent-bound';
const ownerThread = 'thread-root';
const childThread = 'thread-approved-child';
const ownerCat = 'codex-astra';
const childCat = 'codex6-luna';
const userId = 'human';
const delegateEvidence = `proposal:proposal-parent-bound:approved:thread:${childThread}:cat:${childCat}`;
const developmentScope = {
  featureRef: 'feature:F322',
  phaseKey: 'B',
  workUnitRef: 'file:docs/plans/f322.md#members-settings-configuration',
  acceptedSourceRef: 'file:docs/plans/f322.md#members-settings-configuration',
  acceptedRevision: 'a'.repeat(40),
};

function task(): TaskItem {
  return {
    id: taskId,
    kind: 'work',
    threadId: ownerThread,
    title: taskId,
    why: '',
    status: 'doing',
    ownerCatId: ownerCat,
    userId,
    createdBy: ownerCat,
    createdAt: 1,
    updatedAt: 1,
    entrustedWork: {
      revision: 3,
      admission: {
        basis: 'explicit_entrustment',
        sourceRefs: ['message:owner-source'],
        idempotencyKey: 'parent-bound',
        receiptRef: 'task:receipt:parent-bound:1',
        admittedAt: 1,
      },
      developmentScope,
      intendedOutcome: 'finish exact child work',
      time: {},
      artifactRefs: [],
      closure: { condition: 'done', expectedSignal: 'terminal_report', state: 'open', evidenceRefs: [] },
    },
  } as TaskItem;
}

function lease(input: Partial<ActionSuccessorLease> = {}): ActionSuccessorLease {
  return {
    leaseId: 'lease-parent-bound',
    tenantScope: userId,
    subjectRef: `subject:task:${taskId}`,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: [childCat],
    dispatchId: 'dispatch-parent-bound',
    claimOrigin: 'structured_transfer',
    holderThreadId: childThread,
    predecessorCatId: ownerCat,
    predecessorThreadId: ownerThread,
    issuerStandingEvidenceRef: 'message:owner-transfer',
    generation: 1,
    status: 'active',
    holderOutcomes: {},
    completionCandidates: {},
    evidenceRefs: [delegateEvidence],
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

const delegateProvider = {
  async getForTask() {
    return [{ catId: childCat, threadId: childThread, evidenceRef: delegateEvidence }];
  },
};

test('owner-read projects an exact approved child lease as queued', async () => {
  const service = new EntrustedWorkTaskExecutionService({
    leaseStore: { getByIdentity: async () => lease({ dispatchDeliveryState: 'pending' }) },
    taskApprovedDelegateProvider: delegateProvider,
    invocationRecords: { listRunningByThread: async () => [], get: async () => null },
    turnExecutions: { listRunningByUser: async () => [] },
  });
  const projection = await service.read(task());
  assert.equal(projection.state, 'queued');
  assert.deepEqual(projection.binding, {
    leaseId: 'lease-parent-bound',
    generation: 1,
    threadId: childThread,
    catId: childCat,
  });
});

test('delegate projection fails closed without current provider proof and persisted lease evidence', async () => {
  const cases = [
    {
      name: 'provider unavailable',
      deps: {},
      currentLease: lease(),
      expectedReason: 'binding_source_unavailable',
    },
    {
      name: 'provider read failed',
      deps: {
        taskApprovedDelegateProvider: {
          getForTask: async () => {
            throw new Error('proposal store unavailable');
          },
        },
      },
      currentLease: lease(),
      expectedReason: 'binding_source_unavailable',
    },
    {
      name: 'proposal evidence was not persisted on the admitted lease',
      deps: { taskApprovedDelegateProvider: delegateProvider },
      currentLease: lease({ evidenceRefs: [] }),
      expectedReason: 'binding_task_mismatch',
    },
    {
      name: 'current approved delegate points at another child',
      deps: {
        taskApprovedDelegateProvider: {
          getForTask: async () => [{ catId: childCat, threadId: 'thread-other-child', evidenceRef: delegateEvidence }],
        },
      },
      currentLease: lease(),
      expectedReason: 'binding_task_mismatch',
    },
  ];
  for (const scenario of cases) {
    const service = new EntrustedWorkTaskExecutionService({
      leaseStore: { getByIdentity: async () => scenario.currentLease },
      invocationRecords: { listRunningByThread: async () => [], get: async () => null },
      turnExecutions: { listRunningByUser: async () => [] },
      ...scenario.deps,
    });
    const projection = await service.read(task());
    assert.equal(projection.state, 'unknown', scenario.name);
    assert.equal(projection.reasonCode, scenario.expectedReason, scenario.name);
  }
});

test('running lookup and exact stop stay on the approved child thread', async () => {
  const lookedUpThreads: string[] = [];
  const cancelled: string[][] = [];
  const parent = {
    id: 'inv-parent-bound',
    threadId: childThread,
    userId,
    userMessageId: 'message:carrier',
    targetCats: [childCat],
    intent: 'execute',
    status: 'running' as const,
    idempotencyKey: 'inv-parent-bound',
    actionLeaseCarrier: { kind: 'action_successor' as const, leaseId: 'lease-parent-bound', generation: 1 },
    createdAt: 1,
    updatedAt: 1,
  };
  const service = new EntrustedWorkTaskExecutionService({
    leaseStore: {
      getByIdentity: async () => lease({ dispatchDeliveryState: 'delivered' }),
    },
    taskApprovedDelegateProvider: delegateProvider,
    invocationRecords: {
      listRunningByThread: async (threadId) => {
        lookedUpThreads.push(threadId);
        return threadId === childThread ? [parent] : [];
      },
      get: async () => null,
    },
    turnExecutions: { listRunningByUser: async () => [] },
    tracker: {
      cancelExact(threadId, catId, invocationId, ownerUserId) {
        cancelled.push([threadId, catId, invocationId, ownerUserId]);
        return { state: 'cancelled', cancelled: true, catIds: [catId], executionIds: [invocationId] };
      },
    },
  });
  const inspection = await service.inspect(task());
  assert.equal(inspection.projection.state, 'running');
  assert.deepEqual(lookedUpThreads, [childThread]);
  const stopped = await service.stopAfterTerminal(task(), inspection);
  assert.equal(stopped.state, 'stopped');
  assert.deepEqual(cancelled, [[childThread, childCat, parent.id, userId]]);
});
