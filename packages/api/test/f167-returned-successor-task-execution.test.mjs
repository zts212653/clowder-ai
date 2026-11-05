import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';
import { resolveTaskExecutionBinding } from '../dist/domains/growing/EntrustedWorkTaskExecutionBinding.js';
import { EntrustedWorkTaskExecutionService } from '../dist/domains/growing/EntrustedWorkTaskExecutionService.js';
import {
  CHILD_CAT,
  DEV_SCOPE,
  makeProposal,
  makeTask,
  mockTruthLeaseStore,
  OWNER_CAT,
  PROPOSAL_ID,
  SUBJECT_REF,
  TENANT,
} from './f167-delegate-test-helpers.js';

const SUCCESSOR_CAT = 'kimi';

const { ActionSuccessorAdmissionService } = await import(
  '../dist/domains/ball-custody/ActionSuccessorAdmissionService.js'
);
const { ActionSubjectTruthResolver } = await import('../dist/domains/ball-custody/ActionSubjectTruthResolver.js');
const { createTaskApprovedDelegateProvider } = await import(
  '../dist/domains/ball-custody/ProposalStoreDelegateProvider.js'
);
const { canonicalizeActionTerminalPredicate } = await import(
  '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js'
);
const {
  claimActionSuccessor,
  markActionSuccessorReturnDelivered,
  replaceActionSuccessor,
  returnActionSuccessorToPredecessor,
} = await import('../dist/domains/ball-custody/action-successor-state-machine.js');
const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
const { callbacksRoutes } = await import('../dist/routes/callbacks.js');

function createInvocationRecordStore() {
  return {
    create() {
      return { outcome: 'created', invocationId: 'successor-invocation' };
    },
    update() {},
    get() {
      return null;
    },
  };
}

function returnedLease(ownerThreadId, childThreadId, delegateEvidenceRef) {
  const terminalPredicate = canonicalizeActionTerminalPredicate({
    actionFamily: 'implement',
    subjectRef: SUBJECT_REF,
    predicate: { kind: 'task_done' },
  });
  const claimed = claimActionSuccessor(null, {
    leaseId: 'lease-returned-task-execution',
    tenantScope: TENANT,
    subjectRef: SUBJECT_REF,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: [CHILD_CAT],
    holderThreadId: childThreadId,
    predecessorCatId: OWNER_CAT,
    predecessorThreadId: ownerThreadId,
    dispatchId: 'dispatch:initial-delegate',
    claimOrigin: 'structured_transfer',
    issuerStandingEvidenceRef: 'message:initial-delegate',
    evidenceRefs: [delegateEvidenceRef],
    terminalPredicate,
    now: 100,
  }).lease;
  const returned = returnActionSuccessorToPredecessor(claimed, {
    expectedGeneration: claimed.generation,
    rejectingCatId: CHILD_CAT,
    rejectingThreadId: childThreadId,
    dispatchId: 'dispatch:delegate-return',
    groundingEvidenceRef: 'message:delegate-release',
    now: 200,
  }).lease;
  return markActionSuccessorReturnDelivered(returned, {
    expectedGeneration: returned.generation,
    evidenceRef: 'queue:return-delivered',
    now: 250,
  }).lease;
}

async function createHarness(t, separateProposalSource) {
  const registry = new InvocationRegistry();
  const invocationQueue = new InvocationQueue();
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const ownerThread = await threadStore.create(TENANT, 'Task owner');
  const proposalSource = separateProposalSource
    ? await threadStore.create(TENANT, 'Studio proposal source')
    : ownerThread;
  const child = await threadStore.create(TENANT, 'Approved execution', process.cwd(), ownerThread.id, {
    createdFromProposalId: PROPOSAL_ID,
    sourceThreadId: proposalSource.id,
    approvedBy: TENANT,
    approvedAt: 99,
  });
  const auth = await registry.create(TENANT, OWNER_CAT, ownerThread.id);
  const proposal = makeProposal({
    sourceThreadId: proposalSource.id,
    parentThreadId: ownerThread.id,
    createdThreadId: child.id,
  });
  const delegateEvidenceRef = `proposal:${proposal.proposalId}:approved:thread:${child.id}:cat:${CHILD_CAT}`;
  const task = makeTask({
    threadId: ownerThread.id,
    entrustedWork: { revision: 3, developmentScope: DEV_SCOPE, closure: { state: 'open' } },
    kind: 'work',
  });
  let currentLease = returnedLease(ownerThread.id, child.id, delegateEvidenceRef);
  const leaseStore = {
    async get(id) {
      return id === currentLease.leaseId ? currentLease : null;
    },
    async replace(id, input) {
      assert.equal(id, currentLease.leaseId);
      const result = replaceActionSuccessor(currentLease, input);
      if (result.outcome === 'replaced' || result.outcome === 'reattached') currentLease = result.lease;
      return result;
    },
    async claim() {
      throw new Error('unexpected claim');
    },
    async commitOutcome() {
      throw new Error('unexpected unavailable target');
    },
    async returnToPredecessor() {
      throw new Error('unexpected return');
    },
    async markReturnDelivered() {
      throw new Error('unexpected return delivery');
    },
    async continueFreshRevision() {
      throw new Error('unexpected continuation');
    },
  };
  const delegateProvider = createTaskApprovedDelegateProvider(
    {
      get: async (id) => (id === proposal.proposalId ? proposal : null),
      listAllByThread: async (threadId) => (threadId === proposalSource.id ? [proposal] : []),
    },
    threadStore,
  );
  const resolver = new ActionSubjectTruthResolver(
    mockTruthLeaseStore(),
    { get: async (id) => (id === task.id ? task : null) },
    delegateProvider,
  );
  const app = Fastify();
  t.after(() => app.close());
  await app.register(callbacksRoutes, {
    registry,
    messageStore,
    threadStore,
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    router: {
      async *routeExecution() {
        yield* [];
      },
      getExecutions() {
        return [];
      },
    },
    invocationRecordStore: createInvocationRecordStore(),
    invocationQueue,
    queueProcessor: { async tryAutoExecute() {} },
    actionSuccessorAdmissionService: new ActionSuccessorAdmissionService(leaseStore, resolver),
    actionSuccessorLeaseStore: leaseStore,
  });

  return { app, auth, child, task, delegateProvider, currentLease: () => currentLease };
}

async function reattachSuccessor(fixture, clientMessageId) {
  return fixture.app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers: {
      'x-invocation-id': fixture.auth.invocationId,
      'x-callback-token': fixture.auth.callbackToken,
    },
    payload: {
      threadId: fixture.child.id,
      content: 'Continue the accepted Task in its exact approved child',
      targetCats: [SUCCESSOR_CAT],
      clientMessageId,
      action: {
        subjectRef: SUBJECT_REF,
        actionFamily: 'implement',
        successorSlot: 'implementer',
        mode: 'single',
        claimOrigin: 'structured_transfer',
        replace: {
          leaseId: fixture.currentLease().leaseId,
          expectedGeneration: fixture.currentLease().generation,
        },
        terminalPredicate: { kind: 'task_done' },
      },
    },
  });
}

for (const separateProposalSource of [true, false]) {
  const relation = separateProposalSource ? 'parent-bound' : 'legacy Task-source';
  test(`${relation} returned successor remains visible to owner-read and exact stop`, async (t) => {
    const fixture = await createHarness(t, separateProposalSource);
    const response = await reattachSuccessor(fixture, `returned-task-execution-${relation}`);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().actionLease.outcome, 'reattached');
    const lease = fixture.currentLease();
    assert.equal(lease.generation, 3);
    assert.deepEqual(lease.holderCatIds, [SUCCESSOR_CAT]);

    const currentDelegates = await fixture.delegateProvider.getForTask(
      fixture.task.id,
      fixture.task.threadId,
      fixture.task.ownerCatId,
      TENANT,
      DEV_SCOPE,
    );
    assert.deepEqual(
      currentDelegates.map((delegate) => delegate.catId),
      [CHILD_CAT],
    );

    const running = {
      id: 'inv-unlisted-successor',
      threadId: fixture.child.id,
      userId: TENANT,
      targetCats: [SUCCESSOR_CAT],
      status: 'running',
      actionLeaseCarrier: {
        kind: 'action_successor',
        leaseId: lease.leaseId,
        generation: lease.generation,
      },
    };
    const cancelled = [];
    const execution = new EntrustedWorkTaskExecutionService({
      leaseStore: { getByIdentity: async () => lease },
      taskApprovedDelegateProvider: fixture.delegateProvider,
      invocationRecords: { listRunningByThread: async () => [running], get: async () => running },
      turnExecutions: { listRunningByUser: async () => [] },
      tracker: {
        cancelExact(threadId, catId, invocationId, userId) {
          cancelled.push([threadId, catId, invocationId, userId]);
          return { state: 'cancelled', cancelled: true, catIds: [catId], executionIds: [invocationId] };
        },
      },
    });
    const inspection = await execution.inspect(fixture.task);
    assert.equal(inspection.projection.state, 'running', JSON.stringify(inspection.projection));
    assert.equal(inspection.projection.binding.catId, SUCCESSOR_CAT);
    const stopped = await execution.stopAfterTerminal(fixture.task, inspection);
    assert.equal(stopped.state, 'stopped');
    assert.deepEqual(cancelled, [[fixture.child.id, SUCCESSOR_CAT, running.id, TENANT]]);
  });
}

test('returned successor binding rejects incomplete lineage and current authority drift', async (t) => {
  const fixture = await createHarness(t, true);
  const response = await reattachSuccessor(fixture, 'returned-task-execution-negative-matrix');
  assert.equal(response.statusCode, 200, response.body);
  const validLease = fixture.currentLease();
  const [anchor] = await fixture.delegateProvider.getForTask(
    fixture.task.id,
    fixture.task.threadId,
    fixture.task.ownerCatId,
    TENANT,
    DEV_SCOPE,
  );
  assert.ok(anchor);

  const cases = [
    {
      name: 'proposal anchor evidence missing',
      lease: { ...validLease, evidenceRefs: validLease.evidenceRefs.filter((ref) => ref !== anchor.evidenceRef) },
      task: fixture.task,
    },
    {
      name: 'current generation entry missing',
      lease: { ...validLease, generation: validLease.generation + 1 },
      task: fixture.task,
    },
    {
      name: 'lineage no longer returns through the canonical Task owner',
      lease: {
        ...validLease,
        returnTransitions: validLease.returnTransitions.map((entry) =>
          entry.toGeneration + 1 === validLease.generation ? { ...entry, predecessorCatId: 'other-owner' } : entry,
        ),
      },
      task: fixture.task,
    },
    {
      name: 'lease did not originate from structured transfer authority',
      lease: { ...validLease, claimOrigin: 'existing_standing' },
      task: fixture.task,
    },
    {
      name: 'Task owner drifted after approval and lineage entry',
      lease: validLease,
      task: { ...fixture.task, ownerCatId: 'codex-sol' },
    },
    {
      name: 'Task scope drifted after approval and lineage entry',
      lease: validLease,
      task: {
        ...fixture.task,
        entrustedWork: {
          ...fixture.task.entrustedWork,
          developmentScope: { ...fixture.task.entrustedWork.developmentScope, acceptedRevision: 'b'.repeat(40) },
        },
      },
    },
    {
      name: 'Task tenant differs from the lease',
      lease: validLease,
      task: { ...fixture.task, userId: 'other-user' },
    },
  ];

  for (const scenario of cases) {
    const result = await resolveTaskExecutionBinding(scenario.task, scenario.lease, fixture.delegateProvider);
    assert.equal(result.kind, 'mismatch', scenario.name);
  }
});
