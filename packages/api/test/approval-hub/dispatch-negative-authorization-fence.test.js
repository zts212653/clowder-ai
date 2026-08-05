/**
 * #1291: an assign_work proposal must remain a negative authorization fence
 * for its originating invocation until it is approved. A caller cannot relabel
 * the same delivery as coordinate or omit effectClass to reach normal delivery.
 */
import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { proposedReviewAction } from './helpers.js';

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

async function createFixture(t, options = {}) {
  const [
    { InvocationRegistry },
    { MessageStore },
    { ThreadStore },
    { InMemoryDispatchProposalStore },
    { callbacksRoutes },
  ] = await Promise.all([
    import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'),
    import('../../dist/domains/cats/services/stores/ports/MessageStore.js'),
    import('../../dist/domains/cats/services/stores/ports/ThreadStore.js'),
    import('../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'),
    import('../../dist/routes/callbacks.js'),
  ]);

  const registry = new InvocationRegistry();
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const dispatchProposalStore = new InMemoryDispatchProposalStore();
  const invocationRecordStore = createMockInvocationRecordStore();
  const auditEvents = [];
  const actionAdmissions = [];
  const source = await threadStore.create('user-1', 'Source');
  const target = await threadStore.create('user-1', 'Target');
  await threadStore.addParticipants(source.id, ['opus']);
  await threadStore.addParticipants(target.id, ['sonnet']);

  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore,
    threadStore,
    dispatchProposalStore,
    invocationRecordStore,
    router: createMockRouter(),
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    approvalIngress: { async publish() {} },
    eventAuditLog: options.failAudit
      ? {
          async append() {
            throw new Error('simulated audit sink outage');
          },
        }
      : {
          async append(event) {
            auditEvents.push(event);
            return { id: `audit-${auditEvents.length}`, timestamp: Date.now(), ...event };
          },
        },
    ...(options.withActionAdmission
      ? {
          actionSuccessorAdmissionService: {
            async admit(input) {
              actionAdmissions.push(input);
              return { admit: false, outcome: 'safe_wait', lease: { leaseId: 'existing-lease', generation: 1 } };
            },
          },
          invocationQueue: {},
          queueProcessor: {},
        }
      : {}),
  });
  await app.ready();
  if (options.failExactLookup) {
    dispatchProposalStore.findNegativeAuthorizationBlocks = async () => {
      throw new Error('simulated deny-index outage');
    };
  }
  t.after(() => app.close());

  const auth = await registry.create('user-1', 'opus', source.id);
  return {
    app,
    auth,
    auditEvents,
    actionAdmissions,
    dispatchProposalStore,
    invocationRecordStore,
    messageStore,
    registry,
    sourceId: source.id,
    targetId: target.id,
  };
}

async function post(fixture, auth, payload) {
  return fixture.app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers: {
      'x-invocation-id': auth.invocationId,
      'x-callback-token': auth.callbackToken,
    },
    payload: {
      threadId: fixture.targetId,
      content: '@sonnet\nPlease review the exact HEAD.',
      targetCats: ['sonnet'],
      ...payload,
    },
  });
}

async function createAssignWorkProposal(fixture) {
  const response = await post(fixture, fixture.auth, {
    effectClass: 'assign_work',
    proposedAction: proposedReviewAction(),
    clientMessageId: 'assign-work-key',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'proposal_created');
  const [proposal] = await fixture.dispatchProposalStore.listPendingByUser('user-1');
  assert.ok(proposal, 'assign_work must create a pending proposal');
  return proposal;
}

async function createHeldProposal(fixture, overrides = {}) {
  const { proposal } = await fixture.dispatchProposalStore.create({
    proposalId: `held-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sourceInvocationId: fixture.auth.invocationId,
    sourceThreadId: fixture.sourceId,
    targetThreadId: fixture.targetId,
    senderCatId: 'opus',
    ownerUserId: 'user-1',
    content: 'Held assignment body',
    targetCats: ['sonnet', 'codex'],
    createdAt: Date.now(),
    ...overrides,
  });
  return proposal;
}

test('pending assign_work records its source invocation and blocks a coordinate downgrade before side effects', async (t) => {
  const fixture = await createFixture(t);
  const proposal = await createAssignWorkProposal(fixture);

  assert.equal(proposal.sourceInvocationId, fixture.auth.invocationId);

  const response = await post(fixture, fixture.auth, {
    effectClass: 'coordinate',
    clientMessageId: 'pending-downgrade-key',
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().kind, 'dispatch_negative_authorization_blocked');
  assert.deepEqual(
    fixture.messageStore.getByThread(fixture.targetId, 20, 'user-1'),
    [],
    'blocked callback must not persist a message',
  );
  assert.deepEqual(
    fixture.invocationRecordStore.getRecords(),
    [],
    'blocked callback must not create a child invocation',
  );
  assert.equal(
    (await fixture.registry.getRecord(fixture.auth.invocationId)).clientMessageIds.has('pending-downgrade-key'),
    false,
    'blocked callback must not consume the normal-path idempotency key',
  );
});

test('rejected assign_work blocks an omitted-effect retry and writes a content-free audit event', async (t) => {
  const fixture = await createFixture(t);
  const proposal = await createAssignWorkProposal(fixture);
  assert.ok(await fixture.dispatchProposalStore.reject(proposal.proposalId, 'user-1'));

  const response = await post(fixture, fixture.auth, {
    clientMessageId: 'rejected-omitted-effect-key',
  });

  assert.equal(response.statusCode, 409);
  const body = response.json();
  assert.equal(body.kind, 'dispatch_negative_authorization_blocked');
  assert.deepEqual(body.proposalIds, [proposal.proposalId]);
  assert.deepEqual(body.blockedTargetCats, ['sonnet']);
  assert.equal(fixture.auditEvents.length, 1);
  const [audit] = fixture.auditEvents;
  assert.equal(audit.type, 'dispatch_negative_authorization_blocked');
  assert.equal(audit.data.sourceInvocationId, fixture.auth.invocationId);
  assert.deepEqual(audit.data.proposalIds, [proposal.proposalId]);
  assert.equal(Object.hasOwn(audit.data, 'content'), false, 'audit must never retain message content');
});

test('negative authorization lookup failure is fail-closed before normal-path side effects', async (t) => {
  const fixture = await createFixture(t, { failExactLookup: true });

  const response = await post(fixture, fixture.auth, {
    effectClass: 'coordinate',
    clientMessageId: 'deny-index-unavailable',
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, 'DISPATCH_NEGATIVE_AUTHORIZATION_UNAVAILABLE');
  assert.deepEqual(fixture.messageStore.getByThread(fixture.targetId, 20, 'user-1'), []);
  assert.deepEqual(fixture.invocationRecordStore.getRecords(), []);
  assert.equal(
    (await fixture.registry.getRecord(fixture.auth.invocationId)).clientMessageIds.has('deny-index-unavailable'),
    false,
  );
});

test('negative authorization remains blocked when its audit sink is unavailable', async (t) => {
  const fixture = await createFixture(t, { failAudit: true });
  const proposal = await createAssignWorkProposal(fixture);
  assert.ok(await fixture.dispatchProposalStore.reject(proposal.proposalId, 'user-1'));

  const response = await post(fixture, fixture.auth, {
    effectClass: 'coordinate',
    clientMessageId: 'audit-sink-unavailable',
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().kind, 'dispatch_negative_authorization_blocked');
  assert.deepEqual(fixture.messageStore.getByThread(fixture.targetId, 20, 'user-1'), []);
  assert.deepEqual(fixture.invocationRecordStore.getRecords(), []);
  assert.equal(
    (await fixture.registry.getRecord(fixture.auth.invocationId)).clientMessageIds.has('audit-sink-unavailable'),
    false,
  );
});

test('target-set intersection blocks subset, superset, and reorder as one carrier while disjoint and fresh invocations pass', async (t) => {
  const fixture = await createFixture(t);
  const proposal = await createHeldProposal(fixture);
  assert.ok(await fixture.dispatchProposalStore.reject(proposal.proposalId, 'user-1'));

  for (const [label, targetCats] of [
    ['subset', ['sonnet']],
    ['superset', ['sonnet', 'codex', 'gemini']],
    ['reorder', ['codex', 'sonnet']],
  ]) {
    const blocked = await post(fixture, fixture.auth, {
      content: `Normal ${label} carrier`,
      targetCats,
      effectClass: 'coordinate',
      clientMessageId: `blocked-${label}`,
    });
    assert.equal(blocked.statusCode, 409, `${label} must be blocked as a whole carrier`);
    assert.equal(blocked.json().kind, 'dispatch_negative_authorization_blocked');
  }

  const disjoint = await post(fixture, fixture.auth, {
    content: 'Legitimate FYI for a disjoint target',
    targetCats: ['gemini'],
    effectClass: 'fyi',
    clientMessageId: 'disjoint-fyi',
  });
  assert.equal(disjoint.statusCode, 200, 'disjoint target remains a legal FYI');

  const freshAuth = await fixture.registry.create('user-1', 'opus', fixture.sourceId);
  const freshInvocation = await post(fixture, freshAuth, {
    content: 'Same target from a fresh invocation',
    targetCats: ['sonnet'],
    effectClass: 'coordinate',
    clientMessageId: 'fresh-invocation',
  });
  assert.equal(freshInvocation.statusCode, 200, 'a fresh invocation is not tainted by the old proposal');
});

test('a new structured transfer is blocked before F167 admission, while a verifiable existing transition reaches F167', async (t) => {
  const fixture = await createFixture(t, { withActionAdmission: true });
  const proposal = await createAssignWorkProposal(fixture);
  assert.ok(await fixture.dispatchProposalStore.reject(proposal.proposalId, 'user-1'));

  const defaultTransfer = await post(fixture, fixture.auth, {
    content: 'New structured transfer',
    targetCats: ['sonnet'],
    clientMessageId: 'new-structured-transfer',
    action: proposedReviewAction(),
  });
  assert.equal(defaultTransfer.statusCode, 409);
  assert.equal(defaultTransfer.json().kind, 'dispatch_negative_authorization_blocked');

  const existingTransition = await post(fixture, fixture.auth, {
    content: 'Existing lease return',
    targetCats: ['sonnet'],
    clientMessageId: 'existing-lease-return',
    action: proposedReviewAction({
      returnToPredecessor: {
        leaseId: 'lease-existing',
        expectedGeneration: 1,
        groundingEvidenceRef: 'message:wrong-holder',
      },
    }),
  });
  assert.equal(
    existingTransition.statusCode,
    200,
    'existing transition bypasses this fence and reaches F167 admission',
  );
  assert.equal(existingTransition.json().status, 'safe_wait');
  assert.equal(fixture.actionAdmissions.length, 1);
});

test('unresolved legacy proposals block only pre-cutover invocation retries', async (t) => {
  const fixture = await createFixture(t);
  const originalRecord = await fixture.registry.getRecord(fixture.auth.invocationId);
  assert.ok(originalRecord);
  const cutoverAt = originalRecord.createdAt + 1;
  await createHeldProposal(fixture, {
    proposalId: 'legacy-unresolved',
    sourceInvocationId: undefined,
    targetCats: ['sonnet'],
  });
  assert.equal(await fixture.dispatchProposalStore.getNegativeAuthorizationLegacyCutoverAt(), undefined);
  await fixture.dispatchProposalStore.rebuildNegativeAuthorizationIndexes();
  await fixture.dispatchProposalStore.establishNegativeAuthorizationLegacyCutoverAt(cutoverAt);

  const oldRetry = await post(fixture, fixture.auth, {
    content: 'Old invocation retry',
    targetCats: ['sonnet'],
    effectClass: 'coordinate',
    clientMessageId: 'legacy-old-retry',
  });
  assert.equal(oldRetry.statusCode, 409);
  assert.equal(oldRetry.json().kind, 'legacy_dispatch_lineage_unresolved');

  await new Promise((resolve) => setTimeout(resolve, 5));
  const freshAuth = await fixture.registry.create('user-1', 'opus', fixture.sourceId);
  const freshRecord = await fixture.registry.getRecord(freshAuth.invocationId);
  assert.ok(freshRecord?.createdAt > cutoverAt, 'test requires a truly post-cutover invocation');
  const postCutover = await post(fixture, freshAuth, {
    content: 'Post-cutover normal delivery',
    targetCats: ['sonnet'],
    effectClass: 'coordinate',
    clientMessageId: 'legacy-post-cutover',
  });
  assert.equal(postCutover.statusCode, 200);
});
