import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/setup-cat-registry.js';

const REVIEWED_HEAD = '6a907b316a907b316a907b316a907b316a907b31';

test('typed operator settlement enters the canonical Queue once and replays the same carrier', async () => {
  const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  const { createLegacyLocalReviewContinuationQueueAdapter } = await import(
    '../dist/routes/legacy-local-review-continuation-queue-adapter.js'
  );

  const invocationQueue = new InvocationQueue();
  const messageStore = new MessageStore();
  const decisionMessage = await messageStore.append({
    userId: 'owner-1',
    catId: null,
    threadId: 'thread-author',
    content: 'operator 对旧 Review 的结算选择为“需要修改”。系统未解析原评论正文。',
    mentions: ['codex-sol'],
    timestamp: 200,
    deliveryStatus: 'queued',
    extra: {
      targetCats: ['codex-sol'],
      legacyLocalReviewDisposition: {
        sourceMessageId: 'review-terminal-prose-1',
        leaseId: 'lease-review-1',
        generation: 1,
        subjectRef: 'pr:owner/repo#4074',
        reviewerCatId: 'codex-terra',
        predecessorCatId: 'codex-sol',
        reviewedHeadSha: '6a907b316a907b316a907b316a907b316a907b31',
        verdict: 'changes_requested',
        decisionId: 'decision-review-1',
      },
    },
  });
  const autoExecuteCalls = [];
  const enqueueContinuation = createLegacyLocalReviewContinuationQueueAdapter({
    router: {},
    invocationRecordStore: {},
    socketManager: {
      broadcastToRoom() {},
      emitToUser() {},
    },
    messageStore,
    queueProcessor: {
      async tryAutoExecute(threadId) {
        autoExecuteCalls.push(threadId);
      },
    },
    invocationQueue,
    log: {
      info() {},
      warn() {},
      error() {},
      debug() {},
      fatal() {},
      trace() {},
      child() {
        return this;
      },
    },
  });
  const input = {
    decisionMessage,
    leaseId: 'lease-review-1',
    generation: 1,
    reviewerCatId: 'codex-terra',
    predecessorCatId: 'codex-sol',
    predecessorThreadId: 'thread-author',
  };

  const first = await enqueueContinuation(input);
  assert.equal(first.outcome, 'enqueued');
  const queued = invocationQueue.findEntryWithMessageId('thread-author', decisionMessage.id);
  assert.equal(queued?.id, first.queueEntryId);
  assert.deepEqual(queued?.targetCats, ['codex-sol']);
  assert.equal(queued?.callerCatId, 'codex-terra');
  assert.equal(invocationQueue.list('thread-author', 'owner-1').length, 1);
  assert.deepEqual(autoExecuteCalls, ['thread-author']);

  const persisted = await messageStore.getById(decisionMessage.id);
  assert.equal(persisted?.deliveryStatus, 'queued');
  assert.equal(persisted?.queueCustody?.status, 'queued');
  assert.equal(persisted?.queueCustody?.carrierByTargetCatId['codex-sol']?.entryId, first.queueEntryId);

  const replay = await enqueueContinuation(input);
  assert.deepEqual(replay, { outcome: 'replayed', queueEntryId: first.queueEntryId });
  assert.equal(invocationQueue.list('thread-author', 'owner-1').length, 1);
  assert.deepEqual(autoExecuteCalls, ['thread-author'], 'exact replay must not auto-execute a second carrier');
});

test('restart ignores pre-CAS evidence and restores one post-CAS author continuation', async () => {
  const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
  const { QueuedMessageCustodyStartupReconciler } = await import(
    '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupReconciler.js'
  );
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  const messageStore = new MessageStore();
  messageStore.scanByDeliveryStatus = (status) =>
    messageStore
      .getRecent(100)
      .filter((message) => message.deliveryStatus === status)
      .map((message) => message.id);
  const disposition = {
    sourceMessageId: 'review-terminal-prose-restart',
    leaseId: 'lease-review-restart',
    generation: 4,
    subjectRef: 'pr:owner/repo#4074',
    reviewerCatId: 'codex-terra',
    predecessorCatId: 'codex-sol',
    reviewedHeadSha: '6a907b316a907b316a907b316a907b316a907b31',
    verdict: 'changes_requested',
    decisionId: 'decision-review-restart',
  };
  const decision = await messageStore.append({
    userId: 'owner-1',
    catId: null,
    threadId: 'thread-author',
    content: 'operator 对旧 Review 的结算选择为“需要修改”。',
    mentions: ['codex-sol'],
    timestamp: 200,
    extra: { targetCats: ['codex-sol'], legacyLocalReviewDisposition: disposition },
  });
  const createReconciler = (invocationQueue) =>
    new QueuedMessageCustodyStartupReconciler({
      messageStore,
      invocationQueue,
      invocationRecordStore: {
        async get() {
          return null;
        },
      },
      now: () => 500,
      log: { info() {}, warn() {} },
    });
  const beforeCasQueue = new InvocationQueue();
  const beforeCas = await createReconciler(beforeCasQueue).reconcile();
  assert.equal(beforeCas.entriesRestored, 0);
  assert.deepEqual(beforeCasQueue.list('thread-author', 'owner-1'), []);
  assert.equal((await messageStore.getById(decision.id))?.queueCustody, undefined);

  const prepared = await messageStore.prepareQueueAdmission(decision.id);
  assert.equal(prepared.kind, 'prepared');
  const afterCasQueue = new InvocationQueue();
  const afterCasReconciler = createReconciler(afterCasQueue);
  const firstRestart = await afterCasReconciler.reconcile();
  const secondRestart = await afterCasReconciler.reconcile();

  assert.equal(firstRestart.entriesRestored, 1);
  assert.equal(secondRestart.entriesRestored, 0);
  const restored = afterCasQueue.list('thread-author', 'owner-1');
  assert.equal(restored.length, 1);
  assert.equal(restored[0].messageId, decision.id);
  assert.deepEqual(restored[0].targetCats, ['codex-sol']);
  const persistedDecision = await messageStore.getById(decision.id);
  assert.equal(persistedDecision?.deliveryStatus, 'queued');
  assert.equal(persistedDecision?.queueCustody?.status, 'queued');
});

test('cold restart admits an exact post-CAS decision and restores only the predecessor author', async () => {
  const { recoverActiveLocalReviewVerdict } = await import(
    '../dist/domains/ball-custody/action-successor-local-review-recovery-state-machine.js'
  );
  const { claimActionSuccessor } = await import('../dist/domains/ball-custody/action-successor-state-machine.js');
  const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
  const { QueuedMessageCustodyStartupReconciler } = await import(
    '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupReconciler.js'
  );
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

  const messageStore = new MessageStore();
  messageStore.scanByDeliveryStatus = (status) =>
    messageStore
      .getRecent(100)
      .filter((message) => message.deliveryStatus === status)
      .map((message) => message.id);
  const disposition = {
    sourceMessageId: 'review-terminal-post-cas',
    leaseId: 'lease-review-post-cas',
    generation: 1,
    subjectRef: 'pr:owner/repo#4074',
    reviewerCatId: 'codex-terra',
    predecessorCatId: 'codex-sol',
    reviewedHeadSha: REVIEWED_HEAD,
    verdict: 'changes_requested',
    decisionId: 'decision-review-post-cas',
  };
  const decision = await messageStore.append({
    userId: 'owner-1',
    catId: null,
    threadId: 'thread-author',
    content: 'operator 对旧 Review 的结算选择为“需要修改”。',
    mentions: ['codex-sol'],
    timestamp: 200,
    extra: { targetCats: ['codex-sol'], legacyLocalReviewDisposition: disposition },
  });
  const claimed = claimActionSuccessor(null, {
    leaseId: disposition.leaseId,
    tenantScope: 'owner-1',
    subjectRef: disposition.subjectRef,
    actionFamily: 'review',
    successorSlot: 'reviewer',
    mode: 'single',
    holderCatIds: [disposition.reviewerCatId],
    dispatchId: 'dispatch-review-post-cas',
    claimOrigin: 'structured_transfer',
    holderThreadId: 'thread-reviewer',
    predecessorCatId: disposition.predecessorCatId,
    predecessorThreadId: 'thread-author',
    issuerStandingEvidenceRef: 'task:review-post-cas',
    evidenceRefs: ['dispatch:review-post-cas'],
    terminalPredicate: {
      kind: 'review_delivered',
      owner: 'owner',
      repo: 'repo',
      prNumber: 4074,
      headSha: REVIEWED_HEAD,
      digest: `review:owner/repo#4074:${REVIEWED_HEAD}`,
    },
    now: 100,
  });
  assert.equal(claimed.outcome, 'claimed');
  let persistedLease = claimed.lease;
  let leaseReads = 0;
  const createReconciler = (invocationQueue) =>
    new QueuedMessageCustodyStartupReconciler({
      messageStore,
      invocationQueue,
      invocationRecordStore: {
        async get() {
          return null;
        },
      },
      legacyLocalReviewDispositionLeaseStore: {
        async get(leaseId) {
          leaseReads += 1;
          return leaseId === persistedLease.leaseId ? structuredClone(persistedLease) : null;
        },
      },
      now: () => 500,
      log: { info() {}, warn() {} },
    });
  const beforeCasQueue = new InvocationQueue();
  const beforeCasRestart = await createReconciler(beforeCasQueue).reconcile();
  assert.equal(beforeCasRestart.entriesRestored, 0);
  assert.deepEqual(beforeCasQueue.list('thread-author', 'owner-1'), []);
  assert.equal((await messageStore.getById(decision.id))?.deliveryStatus, undefined);

  const settled = recoverActiveLocalReviewVerdict(claimed.lease, {
    expectedGeneration: disposition.generation,
    reviewerCatId: disposition.reviewerCatId,
    predecessorCatId: disposition.predecessorCatId,
    predecessorThreadId: 'thread-author',
    tenantScope: 'owner-1',
    headSha: REVIEWED_HEAD,
    evidenceRef: `legacy-local-review-disposition:${decision.id}:source:${disposition.sourceMessageId}:g1:changes_requested`,
    now: 220,
  });
  assert.equal(settled.outcome, 'recovered');
  persistedLease = settled.lease;
  const invocationQueue = new InvocationQueue();
  const reconciler = createReconciler(invocationQueue);

  const firstRestart = await reconciler.reconcile();
  const sameProcessReplay = await reconciler.reconcile();

  assert.equal(firstRestart.entriesRestored, 1);
  assert.equal(sameProcessReplay.entriesRestored, 0);
  assert.equal(leaseReads, 2, 'active proof defers once; completed proof admits once; queued replay does not reread');
  const restored = invocationQueue.list('thread-author', 'owner-1');
  assert.equal(restored.length, 1);
  assert.equal(restored[0].messageId, decision.id);
  assert.deepEqual(restored[0].targetCats, ['codex-sol']);
  assert.equal(restored[0].targetCats.includes('codex-terra'), false);
  const persisted = await messageStore.getById(decision.id);
  assert.equal(persisted?.deliveryStatus, 'queued');
  assert.equal(persisted?.queueCustody?.status, 'queued');
  assert.equal(
    messageStore
      .getRecent(100)
      .filter((message) => message.extra?.legacyLocalReviewDisposition?.sourceMessageId === disposition.sourceMessageId)
      .length,
    1,
    'cold recovery must reuse the original decision',
  );
});
