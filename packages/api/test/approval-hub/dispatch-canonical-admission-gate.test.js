/**
 * #1291 Gate 0 — public API RED fixture for canonical work admission.
 *
 * A DispatchProposal owns the operator decision, while an ActionSuccessorLease
 * owns custody. This fixture freezes the seam: a weaker cross-thread carrier
 * must not turn a pending/rejected canonical action into target persistence,
 * Queue work, or a target invocation.
 */
import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

function proposedReviewAction(overrides = {}) {
  return {
    subjectRef: 'pr:owner/repo#42',
    actionFamily: 'review',
    successorSlot: 'reviewer',
    mode: 'single',
    terminalPredicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
    ...overrides,
  };
}

function proposedInvestigationAction() {
  return {
    subjectRef: 'pr:owner/repo#42',
    actionFamily: 'investigate',
    successorSlot: 'investigator',
    mode: 'single',
    terminalPredicate: {
      kind: 'test_passed',
      commandDigest: 'sha256:investigate',
      revisionSha: 'a'.repeat(40),
    },
  };
}

function createMockInvocationRecordStore() {
  const records = [];
  return {
    create(input) {
      const record = { id: `child-${records.length}`, ...input };
      records.push(record);
      return { outcome: 'created', invocationId: record.id };
    },
    update() {},
    get() {
      return null;
    },
    getRecords() {
      return [...records];
    },
  };
}

function createMockRouter() {
  return {
    async *routeExecution() {
      yield* [];
    },
    getExecutions() {
      return [];
    },
  };
}

async function createFixture(t) {
  const [
    { InvocationRegistry },
    { InvocationQueue },
    { MessageStore },
    { ThreadStore },
    { InMemoryDispatchProposalStore },
    { callbacksRoutes },
  ] = await Promise.all([
    import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'),
    import('../../dist/domains/cats/services/agents/invocation/InvocationQueue.js'),
    import('../../dist/domains/cats/services/stores/ports/MessageStore.js'),
    import('../../dist/domains/cats/services/stores/ports/ThreadStore.js'),
    import('../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'),
    import('../../dist/routes/callbacks.js'),
  ]);
  const registry = new InvocationRegistry();
  const invocationQueue = new InvocationQueue();
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const dispatchProposalStore = new InMemoryDispatchProposalStore();
  const invocationRecordStore = createMockInvocationRecordStore();
  const actionAdmissions = [];
  const broadcasts = [];
  const source = await threadStore.create('user-1', 'Source');
  const target = await threadStore.create('user-1', 'Target');
  await threadStore.addParticipants(target.id, ['sonnet']);

  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    invocationQueue,
    messageStore,
    threadStore,
    dispatchProposalStore,
    invocationRecordStore,
    router: createMockRouter(),
    queueProcessor: { async tryAutoExecute() {} },
    socketManager: {
      broadcastAgentMessage(...args) {
        broadcasts.push(args);
      },
      broadcastToRoom() {},
      emitToUser() {},
    },
    approvalIngress: { async publish() {} },
    actionSuccessorAdmissionService: {
      async admit(input) {
        actionAdmissions.push(input);
        return {
          admit: false,
          outcome: 'safe_wait',
          lease: { leaseId: 'existing-lease', generation: 1 },
        };
      },
      async markUnavailable() {},
    },
  });
  await app.ready();
  t.after(() => app.close());

  const auth = await registry.create('user-1', 'opus', source.id);
  return {
    actionAdmissions,
    app,
    auth,
    broadcasts,
    dispatchProposalStore,
    invocationQueue,
    invocationRecordStore,
    messageStore,
    registry,
    sourceId: source.id,
    targetId: target.id,
  };
}

function post(fixture, auth, payload) {
  return fixture.app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers: {
      'x-invocation-id': auth.invocationId,
      'x-callback-token': auth.callbackToken,
    },
    payload: {
      threadId: fixture.targetId,
      content: '@sonnet\nPlease inspect the exact HEAD.',
      targetCats: ['sonnet'],
      ...payload,
    },
  });
}

async function createPendingReviewProposal(fixture) {
  const response = await post(fixture, fixture.auth, {
    effectClass: 'assign_work',
    proposedAction: proposedReviewAction(),
    clientMessageId: 'pending-review-proposal',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'proposal_created');
  const [proposal] = await fixture.dispatchProposalStore.listPendingByUser('user-1');
  assert.ok(proposal, 'assign_work must create a pending proposal');
  assert.deepEqual(proposal.proposedAction, proposedReviewAction());
  return proposal;
}

async function assertNoBlockedWorkSideEffects(fixture, auth, clientMessageId) {
  assert.deepEqual(
    fixture.messageStore.getByThread(fixture.targetId, 20, 'user-1'),
    [],
    'blocked work must not persist a target message',
  );
  assert.deepEqual(
    fixture.invocationQueue.list(fixture.targetId, 'user-1'),
    [],
    'blocked work must not create a Queue entry',
  );
  assert.deepEqual(fixture.invocationRecordStore.getRecords(), [], 'blocked work must not create a target invocation');
  assert.deepEqual(fixture.broadcasts, [], 'blocked work must not emit a target provider broadcast');
  assert.equal(
    (await fixture.registry.getRecord(auth.invocationId)).clientMessageIds.has(clientMessageId),
    false,
    'blocked work must not consume the normal-path idempotency key',
  );
}

test('pending proposal blocks a weaker cross-invocation coordinate carrier before all target side effects', async (t) => {
  const fixture = await createFixture(t);
  const proposal = await createPendingReviewProposal(fixture);
  const freshAuth = await fixture.registry.create('user-1', 'opus', fixture.sourceId);
  const clientMessageId = 'cross-invocation-coordinate-downgrade';

  const response = await post(fixture, freshAuth, {
    content: '@sonnet\nDifferent wording must not change work admission.',
    effectClass: 'coordinate',
    coordination: { phase: 'active', subjectRef: proposal.proposedAction.subjectRef },
    clientMessageId,
  });

  assert.equal(response.statusCode, 409);
  assert.equal((await fixture.dispatchProposalStore.get(proposal.proposalId))?.status, 'pending');
  assert.equal(fixture.actionAdmissions.length, 0, 'blocked action must not reach successor admission');
  await assertNoBlockedWorkSideEffects(fixture, freshAuth, clientMessageId);
});

test('a structured admission rejection cannot be weakened into an actionless coordinate retry', async (t) => {
  const fixture = await createFixture(t);
  const proposal = await createPendingReviewProposal(fixture);
  const freshAuth = await fixture.registry.create('user-1', 'opus', fixture.sourceId);

  const structured = await post(fixture, freshAuth, {
    action: proposedReviewAction(),
    clientMessageId: 'structured-admission-rejected',
  });
  assert.equal(structured.statusCode, 409, 'the structured action must be rejected before successor admission');
  assert.equal(fixture.actionAdmissions.length, 0);
  await assertNoBlockedWorkSideEffects(fixture, freshAuth, 'structured-admission-rejected');

  const clientMessageId = 'actionless-coordinate-after-rejection';
  const downgraded = await post(fixture, freshAuth, {
    content: '@sonnet\nRetrying as a weaker carrier must not bypass the rejected action.',
    effectClass: 'coordinate',
    coordination: { phase: 'active', subjectRef: proposal.proposedAction.subjectRef },
    clientMessageId,
  });

  assert.equal(downgraded.statusCode, 409);
  assert.equal((await fixture.dispatchProposalStore.get(proposal.proposalId))?.status, 'pending');
  assert.equal(fixture.actionAdmissions.length, 0, 'downgrade must not reach successor admission');
  await assertNoBlockedWorkSideEffects(fixture, freshAuth, clientMessageId);
});

test('the full canonical action key, not content or effectClass, blocks a fresh structured carrier', async (t) => {
  const fixture = await createFixture(t);
  await createPendingReviewProposal(fixture);
  const freshAuth = await fixture.registry.create('user-1', 'opus', fixture.sourceId);
  const clientMessageId = 'canonical-key-ignores-carrier-shape';

  const response = await post(fixture, freshAuth, {
    content: '@sonnet\nThis text intentionally shares no words with the held request.',
    effectClass: 'coordinate',
    action: proposedReviewAction({ terminalPredicate: { kind: 'review_delivered', headSha: 'b'.repeat(40) } }),
    clientMessageId,
  });

  assert.equal(response.statusCode, 409);
  assert.equal(fixture.actionAdmissions.length, 0, 'canonical block must precede successor admission');
  await assertNoBlockedWorkSideEffects(fixture, freshAuth, clientMessageId);
});

test('a rejected proposal blocks the same weak coordinate carrier from a fresh invocation', async (t) => {
  const fixture = await createFixture(t);
  const proposal = await createPendingReviewProposal(fixture);
  assert.ok(await fixture.dispatchProposalStore.reject(proposal.proposalId, 'user-1'));
  const freshAuth = await fixture.registry.create('user-1', 'opus', fixture.sourceId);
  const clientMessageId = 'rejected-cross-invocation-coordinate-downgrade';

  const response = await post(fixture, freshAuth, {
    content: '@sonnet\nA rejected action cannot be sent as coordination.',
    effectClass: 'coordinate',
    coordination: { phase: 'active', subjectRef: proposal.proposedAction.subjectRef },
    clientMessageId,
  });

  assert.equal(response.statusCode, 409);
  assert.equal((await fixture.dispatchProposalStore.get(proposal.proposalId))?.status, 'rejected');
  await assertNoBlockedWorkSideEffects(fixture, freshAuth, clientMessageId);
});

test('a structured carrier with a different complete action key remains an independent admission', async (t) => {
  const fixture = await createFixture(t);
  await createPendingReviewProposal(fixture);
  const freshAuth = await fixture.registry.create('user-1', 'opus', fixture.sourceId);

  const response = await post(fixture, freshAuth, {
    content: '@sonnet\nThis is a distinct investigator handoff for the same subject.',
    action: proposedInvestigationAction(),
    clientMessageId: 'different-action-family-is-independent',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'safe_wait');
  assert.equal(fixture.actionAdmissions.length, 1, 'the full action key must reach F167 admission');
});

test('unrelated communication with a different subject remains legal while a review proposal is pending', async (t) => {
  const fixture = await createFixture(t);
  await createPendingReviewProposal(fixture);
  const freshAuth = await fixture.registry.create('user-1', 'opus', fixture.sourceId);

  const response = await post(fixture, freshAuth, {
    content: '@sonnet\nFYI: a separate subject needs no work custody.',
    effectClass: 'coordinate',
    coordination: { phase: 'active', subjectRef: 'pr:owner/repo#43' },
    clientMessageId: 'unrelated-communication',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(fixture.invocationQueue.list(fixture.targetId, 'user-1').length, 1);
});
