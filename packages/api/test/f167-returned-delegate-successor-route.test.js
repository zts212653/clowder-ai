import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';
import {
  CHILD_CAT,
  makeProposal,
  makeProposalLister,
  makeProposalListItem,
  makeProposalStore,
  makeTask,
  mockTruthLeaseStore,
  OWNER_CAT,
  SUBJECT_REF,
  TENANT,
} from './f167-delegate-test-helpers.js';

const SUCCESSOR_CAT = 'kimi';

const { ActionSuccessorAdmissionService } = await import(
  '../dist/domains/ball-custody/ActionSuccessorAdmissionService.js'
);
const { ActionSubjectTruthResolver } = await import('../dist/domains/ball-custody/ActionSubjectTruthResolver.js');
const { ProposalStoreDelegateProvider, ThreadDelegateBindingProvider } = await import(
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

function returnedLease(sourceThreadId, childThreadId, delegateEvidenceRef) {
  const terminalPredicate = canonicalizeActionTerminalPredicate({
    actionFamily: 'implement',
    subjectRef: SUBJECT_REF,
    predicate: { kind: 'task_done' },
  });
  const claimed = claimActionSuccessor(null, {
    leaseId: 'lease-route-task414',
    tenantScope: TENANT,
    subjectRef: SUBJECT_REF,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: [CHILD_CAT],
    holderThreadId: childThreadId,
    predecessorCatId: OWNER_CAT,
    predecessorThreadId: sourceThreadId,
    dispatchId: 'dispatch:initial-route-delegate',
    claimOrigin: 'structured_transfer',
    issuerStandingEvidenceRef: 'message:initial-route-delegate',
    evidenceRefs: [delegateEvidenceRef],
    terminalPredicate,
    now: 100,
  }).lease;
  const returned = returnActionSuccessorToPredecessor(claimed, {
    expectedGeneration: claimed.generation,
    rejectingCatId: CHILD_CAT,
    rejectingThreadId: childThreadId,
    dispatchId: 'dispatch:route-delegate-return',
    groundingEvidenceRef: 'message:route-delegate-release',
    now: 200,
  }).lease;
  return markActionSuccessorReturnDelivered(returned, {
    expectedGeneration: returned.generation,
    evidenceRef: 'queue:route-return-delivered',
    now: 250,
  }).lease;
}

async function createRouteHarness(t) {
  const registry = new InvocationRegistry();
  const invocationQueue = new InvocationQueue();
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const source = await threadStore.create(TENANT, 'Task owner');
  const child = await threadStore.create(TENANT, 'Approved execution', process.cwd(), source.id);
  const auth = await registry.create(TENANT, OWNER_CAT, source.id);
  const proposal = makeProposal({
    sourceThreadId: source.id,
    parentThreadId: source.id,
    createdThreadId: child.id,
  });
  const delegateEvidenceRef = `proposal:${proposal.proposalId}:approved:thread:${child.id}:cat:${CHILD_CAT}`;
  const task = makeTask({ threadId: source.id });
  let lease = returnedLease(source.id, child.id, delegateEvidenceRef);
  const leaseStore = {
    async get(id) {
      return id === lease.leaseId ? lease : null;
    },
    async replace(id, input) {
      assert.equal(id, lease.leaseId);
      const result = replaceActionSuccessor(lease, input);
      if (result.outcome === 'replaced' || result.outcome === 'reattached') lease = result.lease;
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
  const delegateProvider = new ProposalStoreDelegateProvider(
    makeProposalStore(proposal),
    new ThreadDelegateBindingProvider(
      makeProposalLister([
        makeProposalListItem({
          sourceThreadId: source.id,
          parentThreadId: source.id,
          createdThreadId: child.id,
          subjectTaskId: task.id,
        }),
      ]),
    ),
  );
  const resolver = new ActionSubjectTruthResolver(
    mockTruthLeaseStore(),
    {
      async get(id) {
        return id === task.id ? task : null;
      },
    },
    delegateProvider,
  );
  const actionService = new ActionSuccessorAdmissionService(leaseStore, resolver);
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
    actionSuccessorAdmissionService: actionService,
    actionSuccessorLeaseStore: leaseStore,
  });

  return {
    app,
    auth,
    child,
    invocationQueue,
    task,
    currentLease: () => lease,
  };
}

test('real callback route reattaches one successor in the returned delegate child', async (t) => {
  const f = await createRouteHarness(t);

  const response = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers: { 'x-invocation-id': f.auth.invocationId, 'x-callback-token': f.auth.callbackToken },
    payload: {
      threadId: f.child.id,
      content: 'Continue the accepted Task in this approved child',
      targetCats: [SUCCESSOR_CAT],
      clientMessageId: 'returned-successor-route',
      action: {
        subjectRef: SUBJECT_REF,
        actionFamily: 'implement',
        successorSlot: 'implementer',
        mode: 'single',
        claimOrigin: 'structured_transfer',
        replace: { leaseId: f.currentLease().leaseId, expectedGeneration: f.currentLease().generation },
        terminalPredicate: { kind: 'task_done' },
      },
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.deepEqual(body.actionLease, {
    leaseId: f.currentLease().leaseId,
    generation: 3,
    outcome: 'reattached',
  });
  assert.deepEqual(f.currentLease().holderCatIds, [SUCCESSOR_CAT]);
  assert.equal(f.currentLease().holderThreadId, f.child.id);
  assert.equal(f.invocationQueue.list(f.child.id, TENANT).length, 1);
  const fence = f.invocationQueue.list(f.child.id, TENANT)[0].execution.actionSuccessorFence;
  assert.equal(fence.leaseId, f.currentLease().leaseId);
  assert.equal(fence.generation, 3);
  assert.equal(fence.dispatchId, 'cross-post:returned-successor-route');
  assert.equal(fence.invocationLineageRef, 'dispatch:cross-post:returned-successor-route');
  assert.equal(fence.terminalPredicateDigest, f.currentLease().terminalPredicate.digest);
});

test('rejected structured recovery stays local while ordinary A2A still reaches the queue', async (t) => {
  const cases = [
    {
      name: 'missing-source',
      replace: (f) => ({ leaseId: 'missing-returned-lease', expectedGeneration: f.currentLease().generation }),
      assertRejected(response) {
        assert.equal(response.statusCode, 400, response.body);
        assert.equal(response.json().status, 'invalid_action');
        assert.match(response.json().error, /lease not found/);
      },
    },
    {
      name: 'stale-generation',
      replace: (f) => ({
        leaseId: f.currentLease().leaseId,
        expectedGeneration: f.currentLease().generation - 1,
      }),
      assertRejected(response) {
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().status, 'stale_generation');
      },
    },
    {
      name: 'scope-mismatch',
      before(f) {
        f.task.developmentScope = { ...f.task.developmentScope, acceptedRevision: 'b'.repeat(40) };
      },
      replace: (f) => ({ leaseId: f.currentLease().leaseId, expectedGeneration: f.currentLease().generation }),
      assertRejected(response) {
        assert.equal(response.statusCode, 400, response.body);
        assert.equal(response.json().status, 'invalid_action');
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const f = await createRouteHarness(subtest);
      const originalTask = {
        status: f.task.status,
        updatedAt: f.task.updatedAt,
        developmentScope: f.task.developmentScope,
      };
      scenario.before?.(f);
      const rejected = await f.app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-invocation-id': f.auth.invocationId, 'x-callback-token': f.auth.callbackToken },
        payload: {
          threadId: f.child.id,
          content: `Structured recovery ${scenario.name}`,
          targetCats: [SUCCESSOR_CAT],
          clientMessageId: `rejected-${scenario.name}`,
          action: {
            subjectRef: SUBJECT_REF,
            actionFamily: 'implement',
            successorSlot: 'implementer',
            mode: 'single',
            claimOrigin: 'structured_transfer',
            replace: scenario.replace(f),
            terminalPredicate: { kind: 'task_done' },
          },
        },
      });
      scenario.assertRejected(rejected);
      assert.equal(f.invocationQueue.list(f.child.id, TENANT).length, 0);
      assert.equal(f.currentLease().generation, 2, 'a rejected recovery cannot mutate returned custody');

      const ordinary = await f.app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-invocation-id': f.auth.invocationId, 'x-callback-token': f.auth.callbackToken },
        payload: {
          threadId: f.child.id,
          content: `Continue via ordinary A2A after ${scenario.name}`,
          targetCats: [SUCCESSOR_CAT],
          clientMessageId: `ordinary-after-${scenario.name}`,
        },
      });
      assert.equal(ordinary.statusCode, 200, ordinary.body);
      assert.equal(ordinary.json().status, 'ok');
      const entries = f.invocationQueue.list(f.child.id, TENANT);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].execution.actionSuccessorFence, undefined);
      assert.equal(f.task.status, originalTask.status);
      assert.equal(f.task.updatedAt, originalTask.updatedAt);
      assert.deepEqual(
        f.task.developmentScope,
        scenario.name === 'scope-mismatch'
          ? { ...originalTask.developmentScope, acceptedRevision: 'b'.repeat(40) }
          : originalTask.developmentScope,
      );
    });
  }
});
