import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverActiveLocalReviewVerdict } from '../dist/domains/ball-custody/action-successor-local-review-recovery-state-machine.js';
import { claimActionSuccessor } from '../dist/domains/ball-custody/action-successor-state-machine.js';
import { LegacyLocalReviewDispositionService } from '../dist/domains/ball-custody/LegacyLocalReviewDispositionService.js';

const OWNER = 'owner-1';
const SUBJECT = 'pr:owner/repo#4074';
const SOURCE_ID = 'review-terminal-prose-1';
const REVIEWED_HEAD = '6a907b316a907b316a907b316a907b316a907b31';

function createLease(overrides = {}) {
  const result = claimActionSuccessor(null, {
    leaseId: 'lease-review-legacy-1',
    tenantScope: OWNER,
    subjectRef: SUBJECT,
    actionFamily: 'review',
    successorSlot: 'reviewer',
    mode: 'single',
    holderCatIds: ['codex-terra'],
    dispatchId: 'dispatch-review-legacy-1',
    claimOrigin: 'structured_transfer',
    holderThreadId: 'thread-reviewer',
    predecessorCatId: 'codex-sol',
    predecessorThreadId: 'thread-author',
    issuerStandingEvidenceRef: 'task:review-4074',
    evidenceRefs: ['dispatch:review-4074'],
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
  assert.equal(result.outcome, 'claimed');
  return { ...result.lease, ...overrides };
}

function sourceMessage(overrides = {}) {
  return {
    id: SOURCE_ID,
    userId: OWNER,
    catId: 'codex-terra',
    threadId: 'thread-author',
    content: '任意展示文字；服务不得从这里推断 verdict。',
    mentions: ['codex-sol'],
    timestamp: 120,
    origin: 'callback',
    extra: {
      targetCats: ['codex-sol'],
      crossPost: { sourceThreadId: 'thread-reviewer', sourceInvocationId: 'review-invocation-1' },
      coordination: { id: 'coord-review-4074', phase: 'terminal', hop: 1, subjectRef: SUBJECT },
      stream: { invocationId: 'review-parent-1', turnInvocationId: 'review-invocation-1' },
    },
    ...overrides,
  };
}

function createHarness(source = sourceMessage(), options = {}) {
  let lease = createLease();
  const messages = new Map([[source.id, structuredClone(source)]]);
  const byIdempotency = new Map();
  const queueCarriers = new Map();
  let appendCount = 0;
  let prepareAttempts = 0;
  let enqueueAttempts = 0;
  let recoveryAttempts = 0;

  const service = new LegacyLocalReviewDispositionService({
    turnExecutionStore: {
      async get(invocationId) {
        if (invocationId !== 'review-invocation-1') return null;
        return {
          invocationId,
          parentInvocationId: 'review-parent-1',
          threadId: 'thread-reviewer',
          userId: OWNER,
          catId: 'codex-terra',
          executionKind: 'ordinary',
          status: 'succeeded',
          startedAt: 110,
          endedAt: 130,
        };
      },
    },
    invocationRecordStore: {
      async get(invocationId) {
        if (invocationId !== 'review-parent-1') return null;
        return {
          id: invocationId,
          threadId: 'thread-reviewer',
          userId: OWNER,
          targetCats: ['codex-terra'],
          actionLeaseCarrier: { kind: 'action_successor', leaseId: 'lease-review-legacy-1', generation: 1 },
        };
      },
    },
    messageStore: {
      async getById(id) {
        return structuredClone(messages.get(id) ?? null);
      },
      async getByIdempotencyKey(userId, threadId, idempotencyKey) {
        const id = byIdempotency.get(`${userId}\0${threadId}\0${idempotencyKey}`);
        return id ? structuredClone(messages.get(id)) : null;
      },
      async appendIdempotent(input) {
        const key = `${input.userId}\0${input.threadId}\0${input.idempotencyKey}`;
        const existingId = byIdempotency.get(key);
        if (existingId) return { message: structuredClone(messages.get(existingId)), idempotent: true };
        appendCount += 1;
        const message = { ...structuredClone(input), id: `decision-message-${appendCount}` };
        messages.set(message.id, message);
        byIdempotency.set(key, message.id);
        return { message: structuredClone(message), idempotent: false };
      },
      async prepareQueueAdmission(id) {
        prepareAttempts += 1;
        if (options.failPrepareAttempts && prepareAttempts <= options.failPrepareAttempts) {
          throw new Error('simulated interruption after lease CAS before Queue admission');
        }
        const message = messages.get(id);
        if (!message) return { kind: 'not_found' };
        if (message.deliveryStatus === 'queued') {
          return { kind: 'existing', message: structuredClone(message) };
        }
        if (message.deliveryStatus !== undefined || message.queueCustody) return { kind: 'conflict' };
        const prepared = { ...message, deliveryStatus: 'queued' };
        messages.set(id, prepared);
        return { kind: 'prepared', message: structuredClone(prepared) };
      },
    },
    leaseStore: {
      async get(leaseId) {
        return lease.leaseId === leaseId ? structuredClone(lease) : null;
      },
      async recoverLocalReviewVerdict(leaseId, input) {
        assert.equal(leaseId, lease.leaseId);
        recoveryAttempts += 1;
        if (options.throwRecoveryAttempts && recoveryAttempts <= options.throwRecoveryAttempts) {
          throw new Error('simulated process interruption before lease CAS');
        }
        if (options.recoveryOutcome) return structuredClone(options.recoveryOutcome);
        const result = recoverActiveLocalReviewVerdict(lease, input);
        if (result.outcome === 'recovered') lease = result.lease;
        return structuredClone(result);
      },
    },
    async enqueueContinuation(input) {
      enqueueAttempts += 1;
      if (options.failContinuationAttempts && enqueueAttempts <= options.failContinuationAttempts) {
        throw new Error('simulated queue outage');
      }
      const key = `${input.leaseId}:g${input.generation}:${input.decisionMessage.id}`;
      if (queueCarriers.has(key)) return { outcome: 'replayed', queueEntryId: queueCarriers.get(key) };
      const id = `queue-${queueCarriers.size + 1}`;
      queueCarriers.set(key, id);
      return { outcome: 'enqueued', queueEntryId: id };
    },
  });

  return {
    service,
    get lease() {
      return lease;
    },
    messages,
    queueCarriers,
    get appendCount() {
      return appendCount;
    },
    get enqueueAttempts() {
      return enqueueAttempts;
    },
    get prepareAttempts() {
      return prepareAttempts;
    },
    replaceLease(nextLease) {
      lease = structuredClone(nextLease);
    },
  };
}

test('prose terminal is only an exact locator; operator inspection resolves one canonical active lease', async () => {
  const harness = createHarness();
  const result = await harness.service.inspect({ sourceMessageId: SOURCE_ID, ownerUserId: OWNER });

  assert.deepEqual(result, {
    outcome: 'eligible',
    sourceMessageId: SOURCE_ID,
    leaseId: 'lease-review-legacy-1',
    generation: 1,
    subjectRef: SUBJECT,
    reviewerCatId: 'codex-terra',
    predecessorCatId: 'codex-sol',
    predecessorThreadId: 'thread-author',
    reviewedHeadSha: REVIEWED_HEAD,
  });
  assert.equal(harness.lease.status, 'active');
  assert.equal(harness.appendCount, 0);
});

test('one typed operator decision settles the exact generation and admits one replay-safe author continuation', async () => {
  const harness = createHarness();
  const input = {
    sourceMessageId: SOURCE_ID,
    ownerUserId: OWNER,
    decisionId: 'decision-review-4074-1',
    verdict: 'changes_requested',
    now: 200,
  };

  const first = await harness.service.settle(input);
  assert.equal(first.outcome, 'committed');
  assert.equal(first.replayed, false);
  assert.equal(harness.lease.status, 'completed');
  assert.deepEqual(Object.keys(harness.lease.holderOutcomes), ['codex-terra']);
  assert.equal(harness.appendCount, 1);
  assert.equal(harness.queueCarriers.size, 1);

  const decision = harness.messages.get(first.decisionMessageId);
  assert.equal(decision.catId, null, 'operator disposition must not impersonate the reviewer');
  assert.equal(decision.extra.localReviewVerdict, undefined);
  assert.equal(decision.deliveryStatus, 'queued');
  assert.deepEqual(decision.mentions, ['codex-sol']);
  assert.deepEqual(decision.extra.targetCats, ['codex-sol']);
  assert.deepEqual(decision.extra.legacyLocalReviewDisposition, {
    sourceMessageId: SOURCE_ID,
    leaseId: 'lease-review-legacy-1',
    generation: 1,
    subjectRef: SUBJECT,
    reviewerCatId: 'codex-terra',
    predecessorCatId: 'codex-sol',
    reviewedHeadSha: REVIEWED_HEAD,
    verdict: 'changes_requested',
    decisionId: 'decision-review-4074-1',
  });
  assert.match(
    harness.lease.holderOutcomes['codex-terra'].evidenceRef,
    /^legacy-local-review-disposition:decision-message-1:source:review-terminal-prose-1:g1:changes_requested$/,
  );

  const replay = await harness.service.settle(input);
  assert.equal(replay.outcome, 'committed');
  assert.equal(replay.replayed, true);
  assert.equal(replay.decisionMessageId, first.decisionMessageId);
  assert.equal(harness.appendCount, 1);
  assert.equal(harness.queueCarriers.size, 1);
});

test('a conflicting operator choice and foreign or already-typed sources fail closed without side effects', async () => {
  const harness = createHarness();
  const committed = await harness.service.settle({
    sourceMessageId: SOURCE_ID,
    ownerUserId: OWNER,
    decisionId: 'decision-review-4074-conflict',
    verdict: 'changes_requested',
    now: 200,
  });
  assert.equal(committed.outcome, 'committed');

  const conflict = await harness.service.settle({
    sourceMessageId: SOURCE_ID,
    ownerUserId: OWNER,
    decisionId: 'decision-review-4074-conflict',
    verdict: 'approved',
    now: 220,
  });
  assert.deepEqual(conflict, { outcome: 'conflict', reason: 'decision_verdict_mismatch' });
  assert.equal(harness.appendCount, 1);
  assert.equal(harness.queueCarriers.size, 1);

  for (const source of [
    sourceMessage({ userId: 'other-owner' }),
    sourceMessage({
      extra: {
        ...sourceMessage().extra,
        stream: { invocationId: 'review-parent-1', turnInvocationId: 'foreign-review-invocation' },
      },
    }),
    sourceMessage({
      extra: {
        ...sourceMessage().extra,
        localReviewVerdict: { verdict: 'changes_requested', clientMessageId: 'already-typed' },
      },
    }),
  ]) {
    const rejected = createHarness(source);
    const result = await rejected.service.inspect({ sourceMessageId: SOURCE_ID, ownerUserId: OWNER });
    assert.notEqual(result.outcome, 'eligible');
    assert.equal(rejected.appendCount, 0);
    assert.equal(rejected.queueCarriers.size, 0);
  }
});

test('a process interruption before lease CAS reuses the source decision across a new client token', async () => {
  const harness = createHarness(sourceMessage(), { throwRecoveryAttempts: 1 });
  const firstInput = {
    sourceMessageId: SOURCE_ID,
    ownerUserId: OWNER,
    decisionId: 'decision-before-cas-first-client',
    verdict: 'changes_requested',
    now: 280,
  };

  await assert.rejects(harness.service.settle(firstInput), /simulated process interruption before lease CAS/);
  assert.equal(harness.appendCount, 1);
  assert.equal(harness.lease.status, 'active');
  const inertDecision = [...harness.messages.values()].find(
    (message) => message.extra?.legacyLocalReviewDisposition?.decisionId === 'decision-before-cas-first-client',
  );
  assert.notEqual(inertDecision?.deliveryStatus, 'queued', 'pre-CAS evidence must not be restart-admissible');
  assert.deepEqual(inertDecision?.mentions, ['codex-sol']);
  assert.deepEqual(inertDecision?.extra?.targetCats, ['codex-sol']);

  const replay = await harness.service.settle({
    ...firstInput,
    decisionId: 'decision-before-cas-new-client',
    now: 290,
  });
  assert.equal(replay.outcome, 'committed');
  assert.equal(harness.appendCount, 1, 'the exact source owns one decision and Queue carrier slot');
  assert.equal(harness.queueCarriers.size, 1);
  const decision = harness.messages.get(replay.decisionMessageId);
  assert.equal(decision.extra.legacyLocalReviewDisposition.decisionId, 'decision-before-cas-first-client');
});

test('an old terminal source cannot settle a later same-reviewer re-review at a new HEAD', async () => {
  const harness = createHarness();
  const freshHead = '5bec76475bec76475bec76475bec76475bec7647';
  const freshLease = createLease();
  harness.replaceLease({
    ...freshLease,
    generation: 2,
    terminalPredicate: {
      ...freshLease.terminalPredicate,
      headSha: freshHead,
      digest: `review:owner/repo#4074:${freshHead}`,
    },
    revision: 2,
    updatedAt: 500,
  });

  const result = await harness.service.settle({
    sourceMessageId: SOURCE_ID,
    ownerUserId: OWNER,
    decisionId: 'decision-old-source-new-review',
    verdict: 'changes_requested',
    now: 520,
  });

  assert.deepEqual(result, { outcome: 'stale', reason: 'review_source_generation_mismatch' });
  assert.equal(harness.lease.status, 'active');
  assert.equal(harness.lease.generation, 2);
  assert.equal(harness.lease.terminalPredicate.headSha, freshHead);
  assert.equal(harness.appendCount, 0);
  assert.equal(harness.queueCarriers.size, 0);
});

test('a crash after lease CAS replays the same decision and admits the predecessor without reviewer work', async () => {
  const harness = createHarness(sourceMessage(), { failContinuationAttempts: 1 });
  const input = {
    sourceMessageId: SOURCE_ID,
    ownerUserId: OWNER,
    decisionId: 'decision-review-4074-crash-replay',
    verdict: 'changes_requested',
    now: 300,
  };

  const interrupted = await harness.service.settle(input);
  assert.equal(interrupted.outcome, 'continuation_pending');
  assert.equal(harness.lease.status, 'completed', 'the typed terminal must remain durably settled');
  assert.equal(harness.appendCount, 1);
  assert.equal(harness.messages.get(interrupted.decisionMessageId)?.deliveryStatus, 'queued');
  assert.equal(harness.enqueueAttempts, 1);
  assert.equal(harness.queueCarriers.size, 0);

  const replay = await harness.service.settle({ ...input, now: 320 });
  assert.equal(replay.outcome, 'committed');
  assert.equal(replay.replayed, true);
  assert.equal(replay.decisionMessageId, interrupted.decisionMessageId);
  assert.equal(harness.appendCount, 1, 'replay must reuse the exact admitted decision message');
  assert.equal(harness.enqueueAttempts, 2);
  assert.equal(harness.queueCarriers.size, 1);
});

test('a crash after lease CAS but before Queue admission replays the same decision into one carrier', async () => {
  const harness = createHarness(sourceMessage(), { failPrepareAttempts: 1 });
  const input = {
    sourceMessageId: SOURCE_ID,
    ownerUserId: OWNER,
    decisionId: 'decision-review-4074-admission-replay',
    verdict: 'changes_requested',
    now: 340,
  };

  const interrupted = await harness.service.settle(input);
  assert.equal(interrupted.outcome, 'continuation_pending');
  assert.equal(harness.lease.status, 'completed');
  assert.equal(harness.appendCount, 1);
  assert.equal(harness.prepareAttempts, 1);
  assert.equal(harness.messages.get(interrupted.decisionMessageId)?.deliveryStatus, undefined);
  assert.equal(harness.enqueueAttempts, 0);
  assert.equal(harness.queueCarriers.size, 0);

  const replay = await harness.service.settle({ ...input, now: 360 });
  assert.equal(replay.outcome, 'committed');
  assert.equal(replay.replayed, true);
  assert.equal(replay.decisionMessageId, interrupted.decisionMessageId);
  assert.equal(harness.appendCount, 1);
  assert.equal(harness.prepareAttempts, 2);
  assert.equal(harness.messages.get(replay.decisionMessageId)?.deliveryStatus, 'queued');
  assert.equal(harness.enqueueAttempts, 1);
  assert.equal(harness.queueCarriers.size, 1);
});

test('a lost CAS race leaves Queue-inert audit evidence without stranding work', async () => {
  const harness = createHarness(sourceMessage(), {
    recoveryOutcome: { outcome: 'lease_not_active', lease: createLease() },
  });
  const result = await harness.service.settle({
    sourceMessageId: SOURCE_ID,
    ownerUserId: OWNER,
    decisionId: 'decision-review-4074-lost-race',
    verdict: 'changes_requested',
    now: 400,
  });

  assert.deepEqual(result, { outcome: 'stale', reason: 'lease_not_active' });
  const decision = [...harness.messages.values()].find(
    (message) => message.extra?.legacyLocalReviewDisposition?.decisionId === 'decision-review-4074-lost-race',
  );
  assert.equal(decision?.deliveryStatus, undefined);
  assert.deepEqual(decision?.mentions, ['codex-sol']);
  assert.deepEqual(decision?.extra?.targetCats, ['codex-sol']);
  assert.equal(harness.queueCarriers.size, 0);
});
