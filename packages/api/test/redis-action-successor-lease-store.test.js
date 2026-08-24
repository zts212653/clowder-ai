import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const { RedisActionSuccessorLeaseStore } = await import(
  '../dist/domains/ball-custody/RedisActionSuccessorLeaseStore.js'
);
const { ActionSuccessorKeys } = await import('../dist/domains/ball-custody/action-successor-keys.js');
const { canonicalizeActionTerminalPredicate } = await import(
  '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js'
);
const { claimActionSuccessor } = await import('../dist/domains/ball-custody/action-successor-state-machine.js');

const reviewPredicate = (headSha) =>
  canonicalizeActionTerminalPredicate({
    actionFamily: 'review',
    subjectRef: 'pr:owner/repo#2868',
    predicate: { kind: 'review_delivered', headSha },
  });

const taskPredicate = () =>
  canonicalizeActionTerminalPredicate({
    actionFamily: 'implement',
    subjectRef: 'subject:task:task-1',
    predicate: { kind: 'task_done' },
  });

const claimInput = (overrides = {}) => ({
  leaseId: 'lease-1',
  tenantScope: 'user-1',
  subjectRef: 'pr:owner/repo#2868',
  actionFamily: 'merge',
  successorSlot: 'reviewer',
  mode: 'single',
  holderCatIds: ['codex-terra'],
  dispatchId: 'dispatch-1',
  claimOrigin: 'structured_transfer',
  holderThreadId: 'thread-target',
  predecessorCatId: 'codex-sol',
  predecessorThreadId: 'thread-source',
  issuerStandingEvidenceRef: 'message:request-1',
  evidenceRefs: ['message:request-1'],
  terminalPredicate: reviewPredicate('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  now: 100,
  ...overrides,
});

const verifiedCompletionVerdict = (lease, catId, evidenceRef, predicate = lease.terminalPredicate) => {
  const candidate = lease.completionCandidates[catId];
  return {
    status: 'verified',
    evidenceRef,
    predicateDigest: predicate.digest,
    freshnessKey: predicate.freshnessKey,
    candidateRevision: candidate.candidateRevision,
    evidenceDigest: candidate.evidenceDigest,
  };
};

describe('RedisActionSuccessorLeaseStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisActionSuccessorLeaseStore');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
      store = new RedisActionSuccessorLeaseStore(redis);
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['action:successor:*']);
  });

  after(async () => {
    if (!connected) return;
    await cleanupPrefixedRedisKeys(redis, ['action:successor:*']);
    await redis.quit();
  });

  it('single-flights concurrent cross-carrier claims and keeps keys persistent', async () => {
    const [a, b] = await Promise.all([
      store.claim(claimInput()),
      store.claim(
        claimInput({
          leaseId: 'lease-2',
          dispatchId: 'dispatch-cross-post',
          holderCatIds: ['codex'],
          now: 101,
        }),
      ),
    ]);

    assert.deepEqual(new Set([a.outcome, b.outcome]), new Set(['claimed', 'safe_wait']));
    assert.equal(a.lease.leaseId, b.lease.leaseId);
    assert.equal(await redis.ttl(ActionSuccessorKeys.detail(a.lease.leaseId)), -1);
    assert.equal(await redis.ttl(ActionSuccessorKeys.identity(a.lease)), -1);
  });

  it('replays the same dispatch without creating a second lease', async () => {
    const first = await store.claim(claimInput());
    const replay = await store.claim(claimInput({ leaseId: 'lease-retry', now: 110 }));
    assert.equal(first.outcome, 'claimed');
    assert.equal(replay.outcome, 'replayed');
    assert.equal(replay.lease.leaseId, first.lease.leaseId);
    assert.equal(replay.lease.generation, 1);
    assert.deepEqual(await store.preflight(first.lease.leaseId, 1, 'wrong-digest'), {
      ok: false,
      reason: 'predicate_mismatch',
    });
  });

  it('reads pre-S.1 TTL=0 leases without inventing a predecessor route', async () => {
    const legacy = {
      leaseId: 'lease-legacy',
      tenantScope: 'user-1',
      subjectRef: 'pr:owner/repo#2868',
      actionFamily: 'merge',
      successorSlot: 'reviewer',
      key: 'user-1\u001fpr:owner/repo#2868\u001fmerge\u001freviewer',
      mode: 'single',
      holderCatIds: ['codex-terra'],
      dispatchId: 'dispatch-legacy',
      generation: 1,
      status: 'active',
      holderOutcomes: {},
      evidenceRefs: ['message:legacy-claim'],
      revision: 1,
      createdAt: 90,
      updatedAt: 90,
    };
    await redis.set(ActionSuccessorKeys.detail(legacy.leaseId), JSON.stringify(legacy));
    await redis.set(ActionSuccessorKeys.identity(legacy), ActionSuccessorKeys.detail(legacy.leaseId));

    const normalized = await store.get(legacy.leaseId);
    assert.equal(normalized.claimOrigin, 'structured_transfer');
    assert.equal(normalized.holderThreadId, 'legacy:unknown');
    assert.equal(normalized.issuerStandingEvidenceRef, 'message:legacy-claim');
    assert.deepEqual(normalized.returnTransitions, []);
    assert.equal(normalized.predecessorCatId, undefined);
    assert.deepEqual(await store.preflight(legacy.leaseId, 1), { ok: true, reason: 'active' });

    const returned = await store.returnToPredecessor(legacy.leaseId, {
      expectedGeneration: 1,
      rejectingCatId: 'codex-terra',
      rejectingThreadId: 'thread-target',
      dispatchId: 'return-legacy',
      groundingEvidenceRef: 'grounding:mismatch',
      now: 100,
    });
    assert.equal(returned.outcome, 'predecessor_missing');
  });

  it('rejects the same dispatch id when its holder payload changes', async () => {
    const first = await store.claim(claimInput());
    const mismatch = await store.claim(
      claimInput({ leaseId: 'lease-replay-mismatch', holderCatIds: ['codex'], now: 111 }),
    );

    assert.equal(mismatch.outcome, 'replay_mismatch');
    assert.equal(mismatch.lease.leaseId, first.lease.leaseId);
    assert.deepEqual(mismatch.lease.holderCatIds, ['codex-terra']);
  });

  it('allows exactly one concurrent replace after terminal holder proof', async () => {
    const claimed = await store.claim(claimInput());
    const replaceable = await store.commitOutcome(claimed.lease.leaseId, {
      generation: 1,
      catId: 'codex-terra',
      outcome: 'unavailable',
      evidenceRef: 'runtime:quota-exhausted',
      now: 120,
    });
    assert.equal(replaceable.outcome, 'recorded');
    assert.equal(replaceable.lease.status, 'replaceable');

    const [a, b] = await Promise.all([
      store.replace(claimed.lease.leaseId, {
        expectedGeneration: 1,
        holderCatIds: ['gpt52'],
        holderThreadId: 'thread-target',
        predecessorCatId: 'codex-sol',
        predecessorThreadId: 'thread-source',
        dispatchId: 'dispatch-2a',
        terminalPredicate: claimed.lease.terminalPredicate,
        evidenceRef: 'lease:unavailable',
        now: 130,
      }),
      store.replace(claimed.lease.leaseId, {
        expectedGeneration: 1,
        holderCatIds: ['codex'],
        holderThreadId: 'thread-target',
        predecessorCatId: 'codex-sol',
        predecessorThreadId: 'thread-source',
        dispatchId: 'dispatch-2b',
        terminalPredicate: claimed.lease.terminalPredicate,
        evidenceRef: 'lease:unavailable',
        now: 131,
      }),
    ]);

    assert.deepEqual(new Set([a.outcome, b.outcome]), new Set(['replaced', 'stale_generation']));
    const persisted = await store.get(claimed.lease.leaseId);
    assert.equal(persisted.generation, 2);
    assert.equal(persisted.holderCatIds.length, 1);
  });

  it('persists an existing-standing replacement without inventing a predecessor route', async () => {
    const claimed = await store.claim(
      claimInput({
        subjectRef: 'subject:task:task-1',
        actionFamily: 'implement',
        successorSlot: 'implementer',
        holderCatIds: ['codex-sol'],
        claimOrigin: 'existing_standing',
        holderThreadId: 'thread-task',
        predecessorCatId: undefined,
        predecessorThreadId: undefined,
        issuerStandingEvidenceRef: 'message:original-task-assignment',
        terminalPredicate: taskPredicate(),
      }),
    );
    await store.commitOutcome(claimed.lease.leaseId, {
      generation: 1,
      catId: 'codex-sol',
      outcome: 'unavailable',
      evidenceRef: 'queue:not_enqueued',
      now: 120,
    });

    const replaced = await store.replace(claimed.lease.leaseId, {
      expectedGeneration: 1,
      holderCatIds: ['codex-sol'],
      holderThreadId: 'thread-task',
      claimOrigin: 'existing_standing',
      issuerStandingEvidenceRef: 'message:replacement-grounding',
      dispatchId: 'existing-standing:task-1:g2',
      terminalPredicate: taskPredicate(),
      evidenceRef: 'message:replacement-request',
      now: 130,
    });

    assert.equal(replaced.outcome, 'replaced');
    const persisted = await store.get(claimed.lease.leaseId);
    assert.equal(persisted.generation, 2);
    assert.equal(persisted.claimOrigin, 'existing_standing');
    assert.equal(persisted.predecessorCatId, undefined);
    assert.equal(persisted.predecessorThreadId, undefined);
    assert.equal(persisted.issuerStandingEvidenceRef, 'message:replacement-grounding');
  });

  it('atomically installs the incoming terminal predicate on replacement', async () => {
    const oldPredicate = reviewPredicate('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const newPredicate = reviewPredicate('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const claimed = await store.claim(claimInput({ actionFamily: 'review', terminalPredicate: oldPredicate }));
    await store.commitOutcome(claimed.lease.leaseId, {
      generation: 1,
      catId: 'codex-terra',
      outcome: 'unavailable',
      evidenceRef: 'runtime:quota-exhausted',
      now: 120,
    });

    const replaced = await store.replace(claimed.lease.leaseId, {
      expectedGeneration: 1,
      holderCatIds: ['gpt52'],
      holderThreadId: 'thread-target',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
      dispatchId: 'dispatch-current-head',
      terminalPredicate: newPredicate,
      evidenceRef: 'lease:unavailable',
      now: 130,
    });

    assert.equal(replaced.outcome, 'replaced');
    const persisted = await store.get(claimed.lease.leaseId);
    assert.equal(persisted.generation, 2);
    assert.equal(persisted.terminalPredicate.digest, newPredicate.digest);
    assert.deepEqual(await store.preflight(claimed.lease.leaseId, 2, newPredicate.digest), {
      ok: true,
      reason: 'active',
    });
  });

  it('does not replace a generation after durable subject terminal truth exists', async () => {
    const claimed = await store.claim(claimInput());
    await store.commitOutcome(claimed.lease.leaseId, {
      generation: 1,
      catId: 'codex-terra',
      outcome: 'unavailable',
      evidenceRef: 'runtime:quota-exhausted',
      now: 120,
    });
    await store.markSubjectTerminal({
      subjectRef: claimed.lease.subjectRef,
      state: 'closed',
      evidenceRef: 'github:pr:2868:closed',
      now: 121,
    });

    const result = await store.replace(claimed.lease.leaseId, {
      expectedGeneration: 1,
      holderCatIds: ['gpt52'],
      holderThreadId: 'thread-target',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
      dispatchId: 'dispatch-after-terminal',
      terminalPredicate: claimed.lease.terminalPredicate,
      evidenceRef: 'lease:unavailable',
      now: 130,
    });

    assert.equal(result.outcome, 'subject_terminal');
    const persisted = await store.get(claimed.lease.leaseId);
    assert.equal(persisted.generation, 1);
    assert.equal(persisted.status, 'replaceable');
  });

  it('atomically continues exactly one fresh subject revision on the same lease and key', async () => {
    const claimed = await store.claim(
      claimInput({
        actionFamily: 'review',
        terminalPredicate: reviewPredicate('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      }),
    );
    const candidate = await store.recordCompletionCandidate(claimed.lease.leaseId, {
      generation: 1,
      catId: 'codex-terra',
      evidenceRefs: ['community:pr:owner/repo#2868:review:g1'],
      now: 110,
    });
    const completed = await store.commitCompletionVerdict(claimed.lease.leaseId, {
      generation: 1,
      catId: 'codex-terra',
      verdict: verifiedCompletionVerdict(candidate.lease, 'codex-terra', 'community:pr:owner/repo#2868:review:g1'),
      now: 111,
    });
    assert.equal(completed.outcome, 'committed');

    const input = {
      expectedGeneration: 1,
      terminalPredicate: reviewPredicate('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      holderCatIds: ['codex-terra'],
      holderThreadId: 'thread-target',
      claimOrigin: 'structured_transfer',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
      dispatchId: 'dispatch-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      issuerStandingEvidenceRef: 'message:request-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      evidenceRef: 'community:pr:owner/repo#2868:head:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      now: 120,
    };
    const [a, b] = await Promise.all([
      store.continueFreshRevision(claimed.lease.leaseId, input),
      store.continueFreshRevision(claimed.lease.leaseId, input),
    ]);

    assert.deepEqual(new Set([a.outcome, b.outcome]), new Set(['continued', 'stale_generation']));
    const persisted = await store.get(claimed.lease.leaseId);
    assert.equal(persisted.key, claimed.lease.key);
    assert.equal(persisted.generation, 2);
    assert.equal(persisted.status, 'active');
    assert.deepEqual(await store.preflight(persisted.leaseId, 1), { ok: false, reason: 'stale_generation' });
  });

  it('atomically upgrades a completed legacy generation to a predicate-backed revision', async () => {
    const predicateBacked = claimActionSuccessor(null, claimInput({ actionFamily: 'review' })).lease;
    const {
      terminalPredicate: _terminalPredicate,
      terminalPredicateState: _terminalPredicateState,
      ...legacyLease
    } = predicateBacked;
    const detailKey = ActionSuccessorKeys.detail(legacyLease.leaseId);
    const identityKey = ActionSuccessorKeys.identity(legacyLease);
    const indexedDetailKey = `${redis.options.keyPrefix}${detailKey}`;
    await redis.set(detailKey, JSON.stringify(legacyLease));
    await redis.set(identityKey, indexedDetailKey);
    await redis.sadd(ActionSuccessorKeys.ALL, indexedDetailKey);
    assert.equal(await redis.get(identityKey), indexedDetailKey);
    assert.equal(ActionSuccessorKeys.identity(await store.get(legacyLease.leaseId)), identityKey);

    const completed = await store.commitOutcome(legacyLease.leaseId, {
      generation: 1,
      catId: 'codex-terra',
      outcome: 'succeeded',
      evidenceRef: 'queue:dispatch-1:codex-terra:succeeded',
      now: 110,
    });
    assert.equal(completed.outcome, 'recorded');
    assert.equal(completed.lease.status, 'completed');

    assert.deepEqual(completed.lease.terminalPredicateState, { kind: 'legacy_predicate_absent' });

    const continued = await store.continueFreshRevision(legacyLease.leaseId, {
      expectedGeneration: 1,
      terminalPredicate: reviewPredicate('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      holderCatIds: ['codex-terra'],
      holderThreadId: 'thread-target',
      claimOrigin: 'structured_transfer',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
      dispatchId: 'dispatch-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      issuerStandingEvidenceRef: 'message:request-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      evidenceRef: 'community:pr:owner/repo#2868:head:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      now: 120,
    });

    assert.equal(continued.outcome, 'continued');
    assert.equal(continued.lease.generation, 2);
    assert.equal(continued.lease.status, 'active');
    assert.deepEqual(continued.lease.terminalPredicateState, { kind: 'predicate_backed' });
    assert.ok(continued.lease.terminalPredicate);
  });

  it('atomically exposes output for the verified holder without reopening admission', async () => {
    const predicate = reviewPredicate('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const claimed = await store.claim(claimInput({ actionFamily: 'review', terminalPredicate: predicate }));
    const candidate = await store.recordCompletionCandidate(claimed.lease.leaseId, {
      generation: 1,
      catId: 'codex-terra',
      evidenceRefs: ['community:pr:owner/repo#2868:review:g1'],
      now: 110,
    });
    await store.commitCompletionVerdict(claimed.lease.leaseId, {
      generation: 1,
      catId: 'codex-terra',
      verdict: verifiedCompletionVerdict(
        candidate.lease,
        'codex-terra',
        'community:pr:owner/repo#2868:review:g1',
        predicate,
      ),
      now: 111,
    });

    assert.deepEqual(await store.preflight(claimed.lease.leaseId, 1, predicate.digest), {
      ok: false,
      reason: 'lease_not_active',
    });
    assert.deepEqual(await store.preflightOutput(claimed.lease.leaseId, 1, 'codex-terra', predicate.digest), {
      ok: true,
      reason: 'verified_success',
    });
    assert.deepEqual(await store.preflightOutput(claimed.lease.leaseId, 2, 'codex-terra', predicate.digest), {
      ok: false,
      reason: 'stale_generation',
    });
    assert.deepEqual(await store.preflightOutput(claimed.lease.leaseId, 1, 'codex-terra', 'wrong-digest'), {
      ok: false,
      reason: 'predicate_mismatch',
    });
    assert.deepEqual(await store.preflightOutput(claimed.lease.leaseId, 1, 'opus', predicate.digest), {
      ok: false,
      reason: 'holder_not_assigned',
    });
    await store.markSubjectTerminal({
      subjectRef: claimed.lease.subjectRef,
      state: 'closed',
      evidenceRef: 'github:pr:2868:closed',
      now: 112,
    });
    assert.deepEqual(await store.preflightOutput(claimed.lease.leaseId, 1, 'codex-terra', predicate.digest), {
      ok: false,
      reason: 'subject_terminal',
    });
  });

  it('keeps concurrent completion candidates isolated per holder', async () => {
    const predicate = reviewPredicate('cccccccccccccccccccccccccccccccccccccccc');
    const claimed = await store.claim(
      claimInput({
        actionFamily: 'review',
        mode: 'parallel',
        holderCatIds: ['codex-terra', 'opus'],
        parallelIntent: 'independent_review',
        terminalPredicate: predicate,
      }),
    );

    await Promise.all([
      store.recordCompletionCandidate(claimed.lease.leaseId, {
        generation: 1,
        catId: 'codex-terra',
        evidenceRefs: ['community:pr:owner/repo#2868:review:terra'],
        now: 110,
      }),
      store.recordCompletionCandidate(claimed.lease.leaseId, {
        generation: 1,
        catId: 'opus',
        evidenceRefs: ['community:pr:owner/repo#2868:review:opus'],
        now: 111,
      }),
    ]);

    const persisted = await store.get(claimed.lease.leaseId);
    assert.deepEqual(Object.keys(persisted.completionCandidates).sort(), ['codex-terra', 'opus']);

    const terraFailed = await store.commitOutcome(claimed.lease.leaseId, {
      generation: 1,
      catId: 'codex-terra',
      outcome: 'failed',
      evidenceRef: 'runtime:terra:failed',
      now: 112,
    });
    assert.equal(terraFailed.outcome, 'recorded');
    assert.equal(terraFailed.lease.completionCandidates['codex-terra'], undefined);
    assert.ok(terraFailed.lease.completionCandidates.opus);
    assert.deepEqual(await store.preflightOutput(claimed.lease.leaseId, 1, 'codex-terra', predicate.digest), {
      ok: false,
      reason: 'holder_terminal',
    });
    assert.deepEqual(await store.preflightOutput(claimed.lease.leaseId, 1, 'opus', predicate.digest), {
      ok: true,
      reason: 'active',
    });

    const lateTerraVerdict = await store.commitCompletionVerdict(claimed.lease.leaseId, {
      generation: 1,
      catId: 'codex-terra',
      verdict: verifiedCompletionVerdict(
        persisted,
        'codex-terra',
        'community:pr:owner/repo#2868:review:terra',
        predicate,
      ),
      now: 113,
    });
    assert.equal(lateTerraVerdict.outcome, 'holder_outcome_exists');

    const opusCommitted = await store.commitCompletionVerdict(claimed.lease.leaseId, {
      generation: 1,
      catId: 'opus',
      verdict: verifiedCompletionVerdict(
        terraFailed.lease,
        'opus',
        'community:pr:owner/repo#2868:review:opus',
        predicate,
      ),
      now: 114,
    });
    assert.equal(opusCommitted.outcome, 'committed');
    assert.equal(opusCommitted.lease.status, 'completed');
    assert.deepEqual(opusCommitted.lease.completionCandidates, {});
  });

  it('keeps a parallel lease active until a failed holder follows a verified success', async () => {
    const predicate = reviewPredicate('dddddddddddddddddddddddddddddddddddddddd');
    const claimed = await store.claim(
      claimInput({
        actionFamily: 'review',
        mode: 'parallel',
        holderCatIds: ['codex-terra', 'opus'],
        parallelIntent: 'independent_review',
        terminalPredicate: predicate,
      }),
    );

    const candidate = await store.recordCompletionCandidate(claimed.lease.leaseId, {
      generation: 1,
      catId: 'opus',
      evidenceRefs: ['community:pr:owner/repo#2868:review:opus'],
      now: 110,
    });
    const opusCommitted = await store.commitCompletionVerdict(claimed.lease.leaseId, {
      generation: 1,
      catId: 'opus',
      verdict: verifiedCompletionVerdict(
        candidate.lease,
        'opus',
        'community:pr:owner/repo#2868:review:opus',
        predicate,
      ),
      now: 111,
    });

    assert.equal(opusCommitted.outcome, 'committed');
    assert.equal(opusCommitted.lease.status, 'active');
    const terraFailed = await store.commitOutcome(claimed.lease.leaseId, {
      generation: 1,
      catId: 'codex-terra',
      outcome: 'failed',
      evidenceRef: 'queue:dispatch-1:codex-terra:failed',
      now: 112,
    });
    assert.equal(terraFailed.outcome, 'recorded');
    assert.equal(terraFailed.lease.status, 'completed');
    assert.equal(terraFailed.lease.holderOutcomes.opus.outcome, 'succeeded');
    assert.equal(terraFailed.lease.holderOutcomes['codex-terra'].outcome, 'failed');
  });

  it('persists fresh-revision claim provenance without retaining the prior predecessor route', async () => {
    const claimed = await store.claim(
      claimInput({
        actionFamily: 'review',
        terminalPredicate: reviewPredicate('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      }),
    );
    const candidate = await store.recordCompletionCandidate(claimed.lease.leaseId, {
      generation: 1,
      catId: 'codex-terra',
      evidenceRefs: ['community:pr:owner/repo#2868:review:g1'],
      now: 110,
    });
    await store.commitCompletionVerdict(claimed.lease.leaseId, {
      generation: 1,
      catId: 'codex-terra',
      verdict: verifiedCompletionVerdict(candidate.lease, 'codex-terra', 'community:pr:owner/repo#2868:review:g1'),
      now: 111,
    });

    const result = await store.continueFreshRevision(claimed.lease.leaseId, {
      expectedGeneration: 1,
      terminalPredicate: reviewPredicate('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      holderCatIds: ['codex-sol'],
      holderThreadId: 'thread-source',
      claimOrigin: 'existing_standing',
      dispatchId: 'dispatch-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-self',
      issuerStandingEvidenceRef: 'grounding:verified-owner',
      evidenceRef: 'community:pr:owner/repo#2868:head:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      now: 120,
    });

    assert.equal(result.outcome, 'continued');
    const persisted = await store.get(claimed.lease.leaseId);
    assert.equal(persisted.claimOrigin, 'existing_standing');
    assert.equal(persisted.predecessorCatId, undefined);
    assert.equal(persisted.predecessorThreadId, undefined);
  });

  it('rejects a completion verdict when terminal truth appears after candidate verification', async () => {
    const claimed = await store.claim(
      claimInput({
        actionFamily: 'review',
        terminalPredicate: reviewPredicate('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      }),
    );
    const candidate = await store.recordCompletionCandidate(claimed.lease.leaseId, {
      generation: 1,
      catId: 'codex-terra',
      evidenceRefs: ['community:pr:owner/repo#2868:review:g1'],
      now: 110,
    });
    await store.markSubjectTerminal({
      subjectRef: claimed.lease.subjectRef,
      state: 'closed',
      evidenceRef: 'github:pr:2868:closed',
      now: 111,
    });

    const result = await store.commitCompletionVerdict(claimed.lease.leaseId, {
      generation: 1,
      catId: 'codex-terra',
      verdict: verifiedCompletionVerdict(candidate.lease, 'codex-terra', 'community:pr:owner/repo#2868:review:g1'),
      now: 112,
    });

    assert.equal(result.outcome, 'subject_terminal');
    const persisted = await store.get(claimed.lease.leaseId);
    assert.equal(persisted.status, 'active');
    assert.equal(persisted.holderOutcomes['codex-terra'], undefined);
  });

  it('rejects a fresh revision when terminal truth appears after freshness verification', async () => {
    const claimed = await store.claim(
      claimInput({
        actionFamily: 'review',
        terminalPredicate: reviewPredicate('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      }),
    );
    const candidate = await store.recordCompletionCandidate(claimed.lease.leaseId, {
      generation: 1,
      catId: 'codex-terra',
      evidenceRefs: ['community:pr:owner/repo#2868:review:g1'],
      now: 110,
    });
    const completed = await store.commitCompletionVerdict(claimed.lease.leaseId, {
      generation: 1,
      catId: 'codex-terra',
      verdict: verifiedCompletionVerdict(candidate.lease, 'codex-terra', 'community:pr:owner/repo#2868:review:g1'),
      now: 111,
    });
    assert.equal(completed.outcome, 'committed');
    await store.markSubjectTerminal({
      subjectRef: claimed.lease.subjectRef,
      state: 'closed',
      evidenceRef: 'github:pr:2868:closed',
      now: 112,
    });

    const result = await store.continueFreshRevision(claimed.lease.leaseId, {
      expectedGeneration: 1,
      terminalPredicate: reviewPredicate('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      holderCatIds: ['codex-terra'],
      holderThreadId: 'thread-target',
      claimOrigin: 'structured_transfer',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
      dispatchId: 'dispatch-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      issuerStandingEvidenceRef: 'message:request-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      evidenceRef: 'community:pr:owner/repo#2868:head:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      now: 113,
    });

    assert.equal(result.outcome, 'subject_terminal');
    const persisted = await store.get(claimed.lease.leaseId);
    assert.equal(persisted.generation, 1);
    assert.equal(persisted.status, 'completed');
  });

  it('allows exactly one active stale local-review recovery CAS and returns every identical replay as recovered', async () => {
    const claimed = await store.claim(
      claimInput({
        actionFamily: 'review',
        terminalPredicate: reviewPredicate('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      }),
    );
    const recovery = (index) => ({
      expectedGeneration: 1,
      reviewerCatId: 'codex-terra',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
      tenantScope: 'user-1',
      headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidenceRef: 'local-review:message-stale-verdict:g1:changes_requested',
      now: 120 + index,
    });

    const attempts = await Promise.all(
      Array.from({ length: 12 }, (_, index) => store.recoverLocalReviewVerdict(claimed.lease.leaseId, recovery(index))),
    );

    assert.equal(attempts.filter((result) => result.outcome === 'recovered').length, 1);
    assert.equal(attempts.filter((result) => result.outcome === 'replayed').length, 11);
    assert.equal(attempts.filter((result) => result.outcome === 'lease_not_active').length, 0);
    const persisted = await store.get(claimed.lease.leaseId);
    assert.equal(persisted.status, 'completed');
    assert.equal(persisted.holderOutcomes['codex-terra'].outcome, 'succeeded');
    assert.ok(persisted.evidenceRefs.includes('local-review:message-stale-verdict:g1:changes_requested'));

    const conflictingReplay = await store.recoverLocalReviewVerdict(claimed.lease.leaseId, {
      ...recovery(12),
      evidenceRef: 'local-review:another-message:g1:changes_requested',
    });
    assert.equal(conflictingReplay.outcome, 'lease_not_active');

    const reentry = await store.continueFreshRevision(claimed.lease.leaseId, {
      expectedGeneration: 1,
      terminalPredicate: reviewPredicate('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      holderCatIds: ['kimi'],
      holderThreadId: 'thread-next-review',
      claimOrigin: 'structured_transfer',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
      dispatchId: 'dispatch-fresh-review',
      issuerStandingEvidenceRef: 'message:fresh-review-request',
      evidenceRef: 'tracking:pr:owner/repo#2868:head:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      reviewReentry: { reason: 'stale_or_blocking', evidenceRef: 'message-stale-verdict' },
      now: 150,
    });
    assert.equal(reentry.outcome, 'continued');
    assert.equal(reentry.lease.generation, 2);
    assert.deepEqual(reentry.lease.holderCatIds, ['kimi']);
    assert.equal(reentry.lease.status, 'active');
  });

  it('does not overwrite a completion candidate that races historical local-review recovery', async () => {
    const claimed = await store.claim(
      claimInput({
        actionFamily: 'review',
        terminalPredicate: reviewPredicate('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      }),
    );
    await store.recordCompletionCandidate(claimed.lease.leaseId, {
      generation: 1,
      catId: 'codex-terra',
      evidenceRefs: ['community:pr:owner/repo#2868:review:g1'],
      now: 110,
    });

    const result = await store.recoverLocalReviewVerdict(claimed.lease.leaseId, {
      expectedGeneration: 1,
      reviewerCatId: 'codex-terra',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
      tenantScope: 'user-1',
      headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidenceRef: 'local-review:message-stale-verdict:g1:changes_requested',
      now: 120,
    });

    assert.equal(result.outcome, 'candidate_present');
    const persisted = await store.get(claimed.lease.leaseId);
    assert.equal(persisted.status, 'active');
    assert.ok(persisted.completionCandidates['codex-terra']);
    assert.equal(persisted.holderOutcomes['codex-terra'], undefined);
  });

  it('allows exactly one concurrent return and keeps delivery state in the same lease', async () => {
    const claimed = await store.claim(claimInput());
    const attempts = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.returnToPredecessor(claimed.lease.leaseId, {
          expectedGeneration: 1,
          rejectingCatId: 'codex-terra',
          rejectingThreadId: 'thread-target',
          dispatchId: `return-${index}`,
          groundingEvidenceRef: `grounding:mismatch-${index}`,
          now: 120 + index,
        }),
      ),
    );

    assert.equal(attempts.filter((result) => result.outcome === 'returned').length, 1);
    assert.equal(attempts.filter((result) => result.outcome === 'stale_generation').length, 11);
    const returned = await store.get(claimed.lease.leaseId);
    assert.equal(returned.generation, 2);
    assert.deepEqual(returned.holderCatIds, ['codex-sol']);
    assert.equal(returned.returnDeliveryState, 'pending');
    assert.equal(returned.returnTransitions.length, 1);

    const replayed = await store.returnToPredecessor(returned.leaseId, {
      expectedGeneration: 1,
      rejectingCatId: 'codex-terra',
      rejectingThreadId: 'thread-target',
      dispatchId: returned.dispatchId,
      groundingEvidenceRef: returned.returnTransitions[0].groundingEvidenceRef,
      now: 149,
    });
    assert.equal(replayed.outcome, 'replayed');
    assert.equal(replayed.lease.revision, returned.revision);

    const delivered = await store.markReturnDelivered(returned.leaseId, {
      expectedGeneration: 2,
      evidenceRef: 'queue:return:delivered',
      now: 150,
    });
    assert.equal(delivered.outcome, 'delivered');
    assert.equal(delivered.lease.returnDeliveryState, 'delivered');
    assert.deepEqual(delivered.lease.holderCatIds, ['codex-sol']);
  });

  it('terminalizes a conflicting approved dispatch once and excludes it from recovery', async () => {
    const claimed = await store.claim(claimInput());
    const pending = {
      ...claimed.lease,
      dispatchDeliveryState: 'pending',
      dispatchDeliveryAttemptCount: 0,
    };
    await redis.set(ActionSuccessorKeys.detail(pending.leaseId), JSON.stringify(pending));
    assert.equal((await store.get(pending.leaseId)).dispatchDeliveryState, 'pending');

    const input = {
      expectedGeneration: 1,
      reason: 'carrier_source_conflict',
      evidenceRef: 'message:conflicting-approved-carrier',
      now: 120,
    };
    const attempts = await Promise.all([
      store.markDispatchFailed(claimed.lease.leaseId, input),
      store.markDispatchFailed(claimed.lease.leaseId, { ...input, now: 121 }),
    ]);

    assert.deepEqual(new Set(attempts.map((result) => result.outcome)), new Set(['failed', 'dispatch_not_pending']));
    const persisted = await store.get(claimed.lease.leaseId);
    assert.equal(persisted.status, 'active', 'transport failure must not masquerade as handled work');
    assert.equal(persisted.dispatchDeliveryState, 'failed');
    assert.equal(persisted.dispatchFailureReason, 'carrier_source_conflict');
    assert.equal(persisted.dispatchFailureEvidenceRef, input.evidenceRef);
    assert.equal(await redis.ttl(ActionSuccessorKeys.detail(persisted.leaseId)), -1);
    assert.deepEqual(await store.listPendingDispatches(), []);

    const conflictingReplay = await store.markDispatchFailed(persisted.leaseId, {
      ...input,
      reason: 'carrier_receipt_conflict',
      evidenceRef: 'message:another-carrier',
      now: 122,
    });
    assert.equal(conflictingReplay.outcome, 'dispatch_not_pending');
    assert.equal(conflictingReplay.lease.dispatchFailureReason, 'carrier_source_conflict');
  });

  it('allows exactly one returned-holder reattach and fences every stale replay', async () => {
    const claimed = await store.claim(claimInput({ actionFamily: 'review' }));
    const returned = await store.returnToPredecessor(claimed.lease.leaseId, {
      expectedGeneration: 1,
      rejectingCatId: 'codex-terra',
      rejectingThreadId: 'thread-target',
      dispatchId: 'return-review',
      groundingEvidenceRef: 'grounding:return-review',
      now: 120,
    });
    assert.equal(returned.outcome, 'returned');
    const delivered = await store.markReturnDelivered(returned.lease.leaseId, {
      expectedGeneration: 2,
      evidenceRef: 'queue:return-review:return_enqueued',
      now: 121,
    });
    assert.equal(delivered.outcome, 'delivered');
    const freshPredicate = reviewPredicate('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const attempts = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.replace(returned.lease.leaseId, {
          expectedGeneration: 2,
          holderCatIds: [`reviewer-${index}`],
          holderThreadId: `thread-reviewer-${index}`,
          predecessorCatId: 'codex-sol',
          predecessorThreadId: 'thread-source',
          dispatchId: `dispatch-fresh-${index}`,
          terminalPredicate: freshPredicate,
          evidenceRef: `callback:fresh-${index}`,
          freshnessEvidenceRef: 'community:fresh-head',
          returnedHolderCatId: 'codex-sol',
          returnedHolderThreadId: 'thread-source',
          returnProof: { kind: 'return_delivery', evidenceRef: 'queue:return-review:return_enqueued' },
          now: 130 + index,
        }),
      ),
    );

    assert.equal(attempts.filter((result) => result.outcome === 'reattached').length, 1);
    assert.equal(attempts.filter((result) => result.outcome === 'stale_generation').length, 11);
    const persisted = await store.get(returned.lease.leaseId);
    assert.equal(persisted.generation, 3);
    assert.equal(persisted.predecessorCatId, 'codex-sol');
    assert.equal(persisted.predecessorThreadId, 'thread-source');
    assert.equal(persisted.returnDeliveryState, undefined);
    assert.equal(persisted.returnTransitions.length, 1);
    assert.ok(persisted.evidenceRefs.includes('queue:return-review:return_enqueued'));
    assert.ok(persisted.evidenceRefs.includes('community:fresh-head'));
  });

  it('enumerates pending/overdue returns and persists one overdue transition with attempt history', async () => {
    const claimed = await store.claim(claimInput());
    const returned = await store.returnToPredecessor(claimed.lease.leaseId, {
      expectedGeneration: 1,
      rejectingCatId: 'codex-terra',
      rejectingThreadId: 'thread-target',
      dispatchId: 'return-recovery',
      groundingEvidenceRef: 'grounding:return-recovery',
      now: 120,
    });
    assert.equal(returned.outcome, 'returned');

    const pending = await store.listPendingReturns();
    assert.deepEqual(
      pending.map((lease) => lease.leaseId),
      [claimed.lease.leaseId],
    );
    assert.equal(pending[0].returnDeliveryAttemptCount, 0);

    const firstAttempt = await store.recordReturnDeliveryAttempt(claimed.lease.leaseId, {
      expectedGeneration: 2,
      now: returned.lease.returnDeliverySlaUntil + 1,
    });
    assert.equal(firstAttempt.outcome, 'recorded');
    assert.equal(firstAttempt.becameOverdue, true);
    assert.equal(firstAttempt.lease.returnDeliveryState, 'overdue');
    assert.equal(firstAttempt.lease.returnDeliveryAttemptCount, 1);

    const secondAttempt = await store.recordReturnDeliveryAttempt(claimed.lease.leaseId, {
      expectedGeneration: 2,
      now: returned.lease.returnDeliverySlaUntil + 2,
    });
    assert.equal(secondAttempt.outcome, 'recorded');
    assert.equal(secondAttempt.becameOverdue, false);
    assert.equal(secondAttempt.lease.returnDeliveryAttemptCount, 2);
    assert.equal(
      secondAttempt.lease.returnDeliveryOverdueObservedAt,
      firstAttempt.lease.returnDeliveryOverdueObservedAt,
    );

    const delivered = await store.markReturnDelivered(claimed.lease.leaseId, {
      expectedGeneration: 2,
      evidenceRef: 'queue:return-recovery',
      now: returned.lease.returnDeliverySlaUntil + 3,
    });
    assert.equal(delivered.outcome, 'delivered');
    assert.deepEqual(await store.listPendingReturns(), []);
  });

  it('does not return custody after durable subject terminal truth exists', async () => {
    const claimed = await store.claim(claimInput());
    await store.markSubjectTerminal({
      subjectRef: claimed.lease.subjectRef,
      state: 'merged',
      evidenceRef: 'github:pr:2868:merged',
      now: 119,
    });

    const result = await store.returnToPredecessor(claimed.lease.leaseId, {
      expectedGeneration: 1,
      rejectingCatId: 'codex-terra',
      rejectingThreadId: 'thread-target',
      dispatchId: 'return-after-terminal',
      groundingEvidenceRef: 'grounding:mismatch',
      now: 120,
    });

    assert.equal(result.outcome, 'subject_terminal');
    const persisted = await store.get(claimed.lease.leaseId);
    assert.equal(persisted.generation, 1);
    assert.equal(persisted.status, 'active');
    assert.equal(persisted.holderOutcomes['codex-terra'], undefined);
  });

  it('atomically records concurrent parallel rejections without returning the whole lease', async () => {
    const claimed = await store.claim(
      claimInput({
        mode: 'parallel',
        holderCatIds: ['codex-terra', 'opus'],
        parallelIntent: 'independent review',
      }),
    );
    const attempts = await Promise.all([
      store.returnToPredecessor(claimed.lease.leaseId, {
        expectedGeneration: 1,
        rejectingCatId: 'codex-terra',
        rejectingThreadId: 'thread-target',
        dispatchId: 'return-terra',
        groundingEvidenceRef: 'grounding:terra-mismatch',
        now: 120,
      }),
      store.returnToPredecessor(claimed.lease.leaseId, {
        expectedGeneration: 1,
        rejectingCatId: 'opus',
        rejectingThreadId: 'thread-target',
        dispatchId: 'return-opus',
        groundingEvidenceRef: 'grounding:opus-mismatch',
        now: 121,
      }),
    ]);

    assert.deepEqual(
      attempts.map((result) => result.outcome),
      ['parallel_return_unsupported', 'parallel_return_unsupported'],
    );
    const persisted = await store.get(claimed.lease.leaseId);
    assert.equal(persisted.generation, 1);
    assert.equal(persisted.status, 'replaceable');
    assert.deepEqual(persisted.holderCatIds, ['codex-terra', 'opus']);
    assert.equal(persisted.holderOutcomes['codex-terra'].outcome, 'rejected_ownership');
    assert.equal(persisted.holderOutcomes.opus.outcome, 'rejected_ownership');
    assert.equal(persisted.returnDeliveryState, undefined);
  });

  it('terminal subject truth blocks new claims and stale preflight', async () => {
    const claimed = await store.claim(claimInput());
    const terminal = await store.markSubjectTerminal({
      subjectRef: 'PR:Owner/Repo#2868',
      state: 'merged',
      evidenceRef: 'github:pr:2868:merged',
      now: 200,
    });
    assert.equal(terminal.subjectRef, 'pr:owner/repo#2868');
    assert.equal(await redis.ttl(ActionSuccessorKeys.subjectTerminal(terminal.subjectRef)), -1);

    const blocked = await store.claim(
      claimInput({ leaseId: 'lease-after-merge', dispatchId: 'dispatch-after-merge', now: 210 }),
    );
    assert.equal(blocked.outcome, 'subject_terminal');
    assert.equal(blocked.terminal.state, 'merged');

    assert.deepEqual(await store.preflight(claimed.lease.leaseId, 1), {
      ok: false,
      reason: 'subject_terminal',
    });
  });

  it('atomically rejects a completion candidate after subject terminal truth appears', async () => {
    const predicate = reviewPredicate('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const claimed = await store.claim(claimInput({ actionFamily: 'review', terminalPredicate: predicate }));
    await store.markSubjectTerminal({
      subjectRef: claimed.lease.subjectRef,
      state: 'closed',
      evidenceRef: 'github:pr:2868:closed',
      now: 150,
    });

    const result = await store.recordCompletionCandidate(claimed.lease.leaseId, {
      generation: 1,
      catId: 'codex-terra',
      evidenceRefs: ['community:pr:owner/repo#2868:review:g1'],
      now: 151,
    });

    assert.equal(result.outcome, 'subject_terminal');
    assert.deepEqual((await store.get(claimed.lease.leaseId)).completionCandidates, {});
  });

  it('atomically rejects legacy success commit after the holder becomes unavailable', async () => {
    const claimed = await store.claim(claimInput());
    await store.commitOutcome(claimed.lease.leaseId, {
      generation: 1,
      catId: 'codex-terra',
      outcome: 'unavailable',
      evidenceRef: 'runtime:timeout',
      now: 150,
    });

    const committed = await store.commitOutcome(claimed.lease.leaseId, {
      generation: 1,
      catId: 'codex-terra',
      outcome: 'succeeded',
      evidenceRef: 'queue:late-success',
      now: 151,
    });

    assert.equal(committed.outcome, 'lease_not_active');
    assert.equal(committed.lease.status, 'replaceable');
    assert.equal(committed.lease.holderOutcomes['codex-terra'].outcome, 'unavailable');
  });

  it('atomically rejects legacy success commit when terminal truth appears after preflight', async () => {
    const claimed = await store.claim(claimInput());
    assert.deepEqual(await store.preflight(claimed.lease.leaseId, 1), { ok: true, reason: 'active' });
    await store.markSubjectTerminal({
      subjectRef: 'pr:owner/repo#2868',
      state: 'merged',
      evidenceRef: 'github:merged',
      now: 160,
    });

    const committed = await store.commitOutcome(claimed.lease.leaseId, {
      generation: 1,
      catId: 'codex-terra',
      outcome: 'succeeded',
      evidenceRef: 'queue:late-success',
      now: 161,
    });

    assert.equal(committed.outcome, 'subject_terminal');
    assert.equal(committed.lease.holderOutcomes['codex-terra'], undefined);
  });

  it('retires a stale terminal marker on newer reopen truth without deleting its history', async () => {
    await store.markSubjectTerminal({
      subjectRef: 'pr:owner/repo#2868',
      state: 'closed',
      evidenceRef: 'github:closed',
      now: 200,
    });
    assert.equal(
      await store.clearSubjectTerminal('pr:owner/repo#2868', {
        evidenceRef: 'github:reopened',
        now: 250,
      }),
      true,
    );
    assert.equal(await store.getSubjectTerminal('pr:owner/repo#2868'), null);
    assert.equal(await redis.scard(ActionSuccessorKeys.subjectTerminalHistory('pr:owner/repo#2868')), 2);
    assert.equal(await redis.ttl(ActionSuccessorKeys.subjectTerminalHistory('pr:owner/repo#2868')), -1);
  });
});
