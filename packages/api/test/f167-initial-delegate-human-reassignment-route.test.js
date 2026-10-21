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
const { claimActionSuccessor, recordActionSuccessorOutcome, replaceActionSuccessor } = await import(
  '../dist/domains/ball-custody/action-successor-state-machine.js'
);
const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
const { callbacksRoutes } = await import('../dist/routes/callbacks.js');

function createInvocationRecordStore() {
  return {
    create() {
      return { outcome: 'created', invocationId: 'human-reassignment-route-invocation' };
    },
    update() {},
    get() {
      return null;
    },
  };
}

function terminalInitialLease(sourceThreadId, childThreadId, delegateEvidenceRef) {
  const terminalPredicate = canonicalizeActionTerminalPredicate({
    actionFamily: 'implement',
    subjectRef: SUBJECT_REF,
    predicate: { kind: 'task_done' },
  });
  const claimed = claimActionSuccessor(null, {
    leaseId: 'lease-route-initial-human-reassignment',
    tenantScope: TENANT,
    subjectRef: SUBJECT_REF,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: [CHILD_CAT],
    holderThreadId: childThreadId,
    predecessorCatId: OWNER_CAT,
    predecessorThreadId: sourceThreadId,
    dispatchId: 'dispatch:route-initial-delegate',
    claimOrigin: 'structured_transfer',
    issuerStandingEvidenceRef: 'message:route-initial-delegate',
    evidenceRefs: [delegateEvidenceRef],
    terminalPredicate,
    now: 100,
  }).lease;
  return recordActionSuccessorOutcome(claimed, {
    generation: 1,
    catId: CHILD_CAT,
    outcome: 'unavailable',
    evidenceRef: 'queue:route-terminal-without-execution',
    now: 180,
  });
}

async function createHarness(t) {
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
  let lease = terminalInitialLease(source.id, child.id, delegateEvidenceRef);
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
      throw new Error('unexpected outcome');
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
  const resolver = new ActionSubjectTruthResolver(
    mockTruthLeaseStore(),
    {
      async get(id) {
        return id === task.id ? task : null;
      },
    },
    new ProposalStoreDelegateProvider(
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
    ),
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
  return { app, auth, child, invocationQueue, messageStore, currentLease: () => lease };
}

function replacementPayload(f, sourceMessageId, clientMessageId) {
  return {
    threadId: f.child.id,
    content: 'Continue the accepted Task after the direct human reassignment',
    targetCats: [SUCCESSOR_CAT],
    clientMessageId,
    action: {
      subjectRef: SUBJECT_REF,
      actionFamily: 'implement',
      successorSlot: 'implementer',
      mode: 'single',
      claimOrigin: 'structured_transfer',
      groundingEvidenceRef: `message:${sourceMessageId}`,
      replace: { leaseId: f.currentLease().leaseId, expectedGeneration: f.currentLease().generation },
      terminalPredicate: { kind: 'task_done' },
    },
  };
}

test('the real callback route derives direct-human proof before replacing terminal g1', async (t) => {
  const f = await createHarness(t);
  const correction = f.messageStore.append({
    userId: TENANT,
    from: { kind: 'user', userId: TENANT },
    threadId: f.child.id,
    content: 'Stop the old delegate; continue here with the new implementer',
    mentions: [],
    timestamp: 200,
  });

  const response = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers: { 'x-invocation-id': f.auth.invocationId, 'x-callback-token': f.auth.callbackToken },
    payload: replacementPayload(f, correction.id, 'initial-human-reassignment-route'),
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().actionLease, {
    leaseId: f.currentLease().leaseId,
    generation: 2,
    outcome: 'replaced',
  });
  assert.deepEqual(f.currentLease().holderCatIds, [SUCCESSOR_CAT]);
  assert.equal(f.currentLease().holderThreadId, f.child.id);
  assert.equal(f.invocationQueue.list(f.child.id, TENANT).length, 1);
  assert.ok(
    f.currentLease().evidenceRefs.some((ref) => ref.startsWith(`human-reassignment:message:${correction.id}:`)),
  );
});

test('a cat-authored grounding message cannot become direct-human reassignment proof', async (t) => {
  const f = await createHarness(t);
  const fake = f.messageStore.append({
    userId: TENANT,
    from: { kind: 'agent', catId: OWNER_CAT },
    threadId: f.child.id,
    content: 'I claim this is a human correction',
    mentions: [],
    timestamp: 200,
  });

  const response = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers: { 'x-invocation-id': f.auth.invocationId, 'x-callback-token': f.auth.callbackToken },
    payload: replacementPayload(f, fake.id, 'fake-human-reassignment-route'),
  });

  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().status, 'invalid_action');
  assert.equal(f.currentLease().generation, 1);
  assert.equal(f.invocationQueue.list(f.child.id, TENANT).length, 0);
});
