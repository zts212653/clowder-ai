import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

let app;

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

test('canonical review decision survives completion rehydration through a real outer-child queue carrier', async () => {
  const reviewedHeadSha = 'f'.repeat(40);
  const subjectRef = 'pr:owner/repo#2915';
  const [
    { InvocationRegistry },
    { InvocationQueue },
    { InvocationRecordStore },
    { MessageStore },
    { ThreadStore },
    { callbacksRoutes },
    { ActionSuccessorAdmissionService },
    { ActionSuccessorCompletionService },
    { ActionSubjectTruthResolver },
    { MessageStoreLocalReviewEvidenceProvider },
    { LocalReviewVerdictService },
    { claimActionSuccessor, commitActionCompletionVerdict, recordActionCompletionCandidate },
    { canonicalizeActionTerminalPredicate },
  ] = await Promise.all([
    import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'),
    import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js'),
    import('../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'),
    import('../dist/domains/cats/services/stores/ports/MessageStore.js'),
    import('../dist/domains/cats/services/stores/ports/ThreadStore.js'),
    import('../dist/routes/callbacks.js'),
    import('../dist/domains/ball-custody/ActionSuccessorAdmissionService.js'),
    import('../dist/domains/ball-custody/ActionSuccessorCompletionService.js'),
    import('../dist/domains/ball-custody/ActionSubjectTruthResolver.js'),
    import('../dist/domains/ball-custody/LocalReviewEvidenceProvider.js'),
    import('../dist/domains/ball-custody/LocalReviewVerdictService.js'),
    import('../dist/domains/ball-custody/action-successor-state-machine.js'),
    import('../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js'),
  ]);

  const registry = new InvocationRegistry();
  const invocationQueue = new InvocationQueue();
  const invocationRecordStore = new InvocationRecordStore();
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const holderThread = await threadStore.create('user-1', 'Canonical review holder');
  const predecessorThread = await threadStore.create('user-1', 'Canonical review predecessor');
  const trigger = await messageStore.append({
    userId: 'user-1',
    catId: 'codex',
    content: 'Review the inherited exact HEAD and return one typed terminal verdict.',
    mentions: ['opus'],
    timestamp: Date.now(),
    threadId: holderThread.id,
    extra: {
      crossPost: { sourceThreadId: predecessorThread.id, effectClass: 'investigate' },
      coordination: { id: 'coord-real-outer-child', phase: 'active', hop: 1, subjectRef },
    },
  });

  let lease = claimActionSuccessor(null, {
    leaseId: 'lease-real-outer-child',
    tenantScope: 'user-1',
    subjectRef,
    actionFamily: 'review',
    successorSlot: 'reviewer',
    mode: 'single',
    holderCatIds: ['opus'],
    dispatchId: 'dispatch-current-review',
    claimOrigin: 'structured_transfer',
    holderThreadId: holderThread.id,
    predecessorCatId: 'codex',
    predecessorThreadId: predecessorThread.id,
    issuerStandingEvidenceRef: 'message:review-request',
    evidenceRefs: ['message:review-request'],
    terminalPredicate: canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef,
      predicate: { kind: 'review_delivered', headSha: reviewedHeadSha },
    }),
    now: 100,
  }).lease;
  lease = { ...lease, generation: 2, revision: lease.revision + 1, updatedAt: 110 };

  const leaseStore = {
    async get(leaseId) {
      return lease.leaseId === leaseId ? lease : null;
    },
    async getByIdentity(identity) {
      return identity.tenantScope === lease.tenantScope &&
        identity.subjectRef === lease.subjectRef &&
        identity.actionFamily === lease.actionFamily &&
        identity.successorSlot === lease.successorSlot
        ? lease
        : null;
    },
    async recordCompletionCandidate(leaseId, input) {
      assert.equal(leaseId, lease.leaseId);
      lease = recordActionCompletionCandidate(lease, input);
      return { outcome: 'recorded', lease };
    },
    async commitCompletionVerdict(leaseId, input) {
      assert.equal(leaseId, lease.leaseId);
      lease = commitActionCompletionVerdict(lease, input);
      return { outcome: 'committed', lease };
    },
    async getSubjectTerminal() {
      return null;
    },
    async markSubjectTerminal() {
      throw new Error('terminal subject transition is not expected');
    },
    async clearSubjectTerminal() {
      throw new Error('terminal subject transition is not expected');
    },
    async recoverLocalReviewVerdict() {
      throw new Error('historical recovery is not expected');
    },
  };

  const staleFence = {
    leaseId: lease.leaseId,
    generation: 1,
    dispatchId: 'dispatch-stale-review',
  };
  const queued = invocationQueue.enqueue({
    threadId: holderThread.id,
    userId: 'user-1',
    ownerAuthProvenance: 'strict',
    idempotencyKey: 'real-outer-child-review-source',
    content: trigger.content,
    messageId: trigger.id,
    source: 'a2a',
    targetCats: ['opus'],
    intent: 'execute',
    actionSuccessorFence: staleFence,
    a2aTriggerMessageId: trigger.id,
  });
  assert.equal(queued.outcome, 'enqueued');
  assert.equal(invocationQueue.markProcessingById(holderThread.id, queued.entry.id, 'opus'), true);
  const outer = invocationRecordStore.create({
    threadId: holderThread.id,
    userId: 'user-1',
    targetCats: ['opus'],
    intent: 'execute',
    idempotencyKey: 'real-outer-child-review-source',
    actionLeaseCarrier: { kind: 'action_successor', leaseId: staleFence.leaseId, generation: staleFence.generation },
  });
  assert.equal(outer.outcome, 'created');
  const auth = await registry.create('user-1', 'opus', holderThread.id, outer.invocationId, trigger.id);

  const evidenceProvider = new MessageStoreLocalReviewEvidenceProvider(messageStore, invocationRecordStore);
  const truthResolver = new ActionSubjectTruthResolver(
    leaseStore,
    {
      async get(candidateSubjectRef) {
        if (candidateSubjectRef !== subjectRef) return null;
        return {
          type: 'pr',
          state: 'in_progress',
          updatedAt: 120,
          externalReview: { currentHeadSha: reviewedHeadSha },
        };
      },
    },
    undefined,
    undefined,
    evidenceProvider,
  );
  const completionService = new ActionSuccessorCompletionService(leaseStore, truthResolver);
  const localReviewVerdictService = new LocalReviewVerdictService({
    leaseStore,
    evidenceProvider,
    truthResolver,
    completeActionLease: (input) => completionService.complete(input),
  });

  app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    invocationQueue,
    invocationRecordStore,
    messageStore,
    threadStore,
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    router: {
      async *routeExecution() {},
      getExecutions() {
        return [];
      },
    },
    queueProcessor: { async tryAutoExecute() {} },
    actionSuccessorAdmissionService: new ActionSuccessorAdmissionService(leaseStore, truthResolver),
    localReviewVerdictService,
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
    payload: {
      threadId: predecessorThread.id,
      content: '@codex\n\nThe inherited exact HEAD is approved.',
      targetCats: ['codex'],
      clientMessageId: 'real-outer-child-canonical-verdict',
      coordination: { phase: 'terminal' },
      localReviewVerdict: 'approved',
      reviewedHeadSha,
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().localReviewSettlement.outcome, 'committed');
  assert.equal(lease.status, 'completed');
  const verdicts = messageStore
    .getByThreadIncludingQueued(predecessorThread.id, 20, 'user-1')
    .filter((message) => message.extra?.localReviewVerdict);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].extra.stream.invocationId, outer.invocationId);
  assert.deepEqual(verdicts[0].extra.localReviewVerdict.carrierlessLeaseFence, {
    leaseId: lease.leaseId,
    generation: 2,
  });
  assert.equal(
    invocationQueue
      .list(predecessorThread.id, 'user-1')
      .filter((entry) => entry.targetCats.length === 1 && entry.targetCats[0] === 'codex').length,
    1,
  );
});
