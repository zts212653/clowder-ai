import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { ActionSubjectTruthResolver } = await import('../dist/domains/ball-custody/ActionSubjectTruthResolver.js');
const { canonicalizeActionTerminalPredicate } = await import(
  '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js'
);
const { createActionCompletionCandidateSnapshot } = await import(
  '../dist/domains/ball-custody/action-successor-completion-state-machine.js'
);

const HEAD_NEW = 'a'.repeat(40);
const HEAD_OLD = 'b'.repeat(40);

const candidate = (evidenceRefs) =>
  createActionCompletionCandidateSnapshot({ evidenceRefs, candidateRevision: 1, recordedAt: 100 });

const activeTrackingSnapshot = (headSha) => ({
  kind: 'pr_tracking',
  status: 'doing',
  headSha,
  ciPrState: null,
  reviewPrState: null,
  closedAt: null,
});

function projection(state, overrides = {}) {
  return {
    repo: 'owner/repo',
    type: 'pr',
    number: 2868,
    subjectKey: 'pr:owner/repo#2868',
    state,
    ownerThreadId: null,
    ownerRole: null,
    nextOwner: 'none',
    lastExternalActivityAt: null,
    lastPublicCommentAt: null,
    linkedIssues: [],
    linkedPrs: [],
    closureWaiver: null,
    appliedEventCount: 1,
    lastRejectedEvent: null,
    deliveryCursor: null,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

function harness({
  marker = null,
  object = null,
  trackingHead,
  trackingSnapshot,
  task = null,
  localReviewEvidenceProvider,
} = {}) {
  const marks = [];
  const leaseStore = {
    async getSubjectTerminal() {
      return marker;
    },
    async markSubjectTerminal(input) {
      const truth = {
        subjectRef: input.subjectRef.toLowerCase(),
        state: input.state,
        evidenceRef: input.evidenceRef,
        observedAt: input.now,
      };
      marks.push(truth);
      return truth;
    },
    async clearSubjectTerminal(subjectRef, input) {
      marks.push({ subjectRef, state: 'active', evidenceRef: input.evidenceRef, observedAt: input.now });
    },
  };
  const communityStore = {
    reads: 0,
    async get() {
      this.reads += 1;
      return object;
    },
  };
  const trackingFreshnessProvider =
    trackingHead !== undefined || trackingSnapshot !== undefined
      ? {
          async getBySubject() {
            return trackingSnapshot ?? activeTrackingSnapshot(trackingHead);
          },
        }
      : undefined;
  return {
    resolver: new ActionSubjectTruthResolver(
      leaseStore,
      communityStore,
      trackingFreshnessProvider,
      {
        async get(taskId) {
          return task?.id === taskId ? task : null;
        },
      },
      localReviewEvidenceProvider,
    ),
    marks,
    communityStore,
  };
}

describe('ActionSubjectTruthResolver', () => {
  it('verifies review completion only for delivered current-HEAD truth and exposes fresh HEAD mechanically', async () => {
    const externalReview = {
      currentHeadSha: HEAD_NEW,
      lastReviewedHeadSha: HEAD_NEW,
      delivery: { kind: 'delivered', headSha: HEAD_NEW },
      ci: null,
    };
    const { resolver } = harness({ object: projection('in_progress', { externalReview }) });
    const predicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: HEAD_NEW },
    });
    const evidenceRef = `community:pr:owner/repo#2868:review:g2:${HEAD_NEW}`;

    const snapshot = candidate([evidenceRef]);
    assert.deepEqual(await resolver.resolveCompletion(predicate, snapshot), {
      status: 'verified',
      evidenceRef,
      predicateDigest: predicate.digest,
      freshnessKey: predicate.freshnessKey,
      candidateRevision: snapshot.candidateRevision,
      evidenceDigest: snapshot.evidenceDigest,
    });
    assert.deepEqual(await resolver.resolveFreshness(predicate), {
      status: 'verified',
      evidenceRef: `community:pr:owner/repo#2868:head:${HEAD_NEW}`,
      freshnessKey: predicate.freshnessKey,
    });

    const oldPredicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: HEAD_OLD },
    });
    assert.equal((await resolver.resolveCompletion(oldPredicate, snapshot)).status, 'mismatch');
  });

  it('verifies a subject-bound GitHub review proof before the community verdict event is projected', async () => {
    const externalReview = {
      currentHeadSha: HEAD_NEW,
      lastReviewedHeadSha: null,
      delivery: null,
      ci: null,
    };
    const { resolver } = harness({ object: projection('in_progress', { externalReview }) });
    const predicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: HEAD_NEW },
    });
    const evidenceRef = 'github:https://github.com/owner/repo/pull/2868#pullrequestreview-100';

    const snapshot = candidate([evidenceRef]);
    assert.deepEqual(await resolver.resolveCompletion(predicate, snapshot), {
      status: 'verified',
      evidenceRef,
      predicateDigest: predicate.digest,
      freshnessKey: predicate.freshnessKey,
      candidateRevision: snapshot.candidateRevision,
      evidenceDigest: snapshot.evidenceDigest,
    });
    assert.equal(
      (
        await resolver.resolveCompletion(
          predicate,
          candidate(['github:https://github.com/owner/repo/pull/9999#pullrequestreview-100']),
        )
      ).status,
      'insufficient',
    );
  });

  it('verifies a durable local-cat verdict message against the exact lease route and HEAD', async () => {
    const evidenceRef = 'local-review:message-1:g2:changes_requested';
    const localReviewEvidenceProvider = {
      async resolve(input) {
        assert.deepEqual(input, {
          evidenceRef,
          leaseId: 'lease-review-2',
          subjectRef: 'pr:owner/repo#2868',
          headSha: HEAD_NEW,
          generation: 2,
          reviewerCatId: 'codex-terra',
          holderThreadId: 'thread-review',
          predecessorCatId: 'codex-sol',
          predecessorThreadId: 'thread-review',
          tenantScope: 'user-1',
        });
        return { status: 'verified', evidenceRef };
      },
    };
    const { resolver } = harness({
      object: projection('in_progress', {
        externalReview: {
          currentHeadSha: HEAD_NEW,
          lastReviewedHeadSha: null,
          delivery: null,
          ci: null,
        },
      }),
      localReviewEvidenceProvider,
    });
    const predicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: HEAD_NEW },
    });
    const snapshot = {
      evidenceRefs: [evidenceRef],
      candidateRevision: 1,
      evidenceDigest: 'local-review-digest',
      recordedAt: 300,
    };

    assert.deepEqual(
      await resolver.resolveCompletion(predicate, snapshot, {
        leaseId: 'lease-review-2',
        generation: 2,
        catId: 'codex-terra',
        holderThreadId: 'thread-review',
        predecessorCatId: 'codex-sol',
        predecessorThreadId: 'thread-review',
        tenantScope: 'user-1',
      }),
      {
        status: 'verified',
        evidenceRef,
        predicateDigest: predicate.digest,
        freshnessKey: predicate.freshnessKey,
        candidateRevision: snapshot.candidateRevision,
        evidenceDigest: snapshot.evidenceDigest,
      },
    );
  });

  it('rejects exact local evidence when the server-observed PR HEAD has advanced', async () => {
    const evidenceRef = 'local-review:message-stale:g2:approved';
    const { resolver } = harness({
      object: projection('in_progress', {
        externalReview: {
          currentHeadSha: HEAD_NEW,
          lastReviewedHeadSha: null,
          delivery: null,
          ci: null,
        },
      }),
      localReviewEvidenceProvider: {
        async resolve() {
          return { status: 'verified', evidenceRef };
        },
      },
    });
    const predicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: HEAD_OLD },
    });

    const result = await resolver.resolveCompletion(predicate, candidate([evidenceRef]), {
      leaseId: 'lease-review-2',
      generation: 2,
      catId: 'codex-terra',
      holderThreadId: 'thread-review',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-review',
      tenantScope: 'user-1',
    });

    assert.equal(result.status, 'mismatch');
    assert.equal(result.reason, 'predicate HEAD is not the server-observed current HEAD');
  });

  it('accepts exact local evidence with active tracking HEAD when community freshness is unavailable', async () => {
    const evidenceRef = 'local-review:message-tracked:g2:approved';
    const { resolver } = harness({
      object: null,
      trackingHead: HEAD_NEW,
      localReviewEvidenceProvider: {
        async resolve() {
          return { status: 'verified', evidenceRef };
        },
      },
    });
    const predicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: HEAD_NEW },
    });

    assert.equal(
      (
        await resolver.resolveCompletion(predicate, candidate([evidenceRef]), {
          leaseId: 'lease-review-2',
          generation: 2,
          catId: 'codex-terra',
          holderThreadId: 'thread-review',
          predecessorCatId: 'codex-sol',
          predecessorThreadId: 'thread-review',
          tenantScope: 'user-1',
        })
      ).status,
      'verified',
    );
  });

  it('rejects exact local evidence when neither current-HEAD source is available', async () => {
    const evidenceRef = 'local-review:message-unfresh:g2:approved';
    const { resolver } = harness({
      object: null,
      localReviewEvidenceProvider: {
        async resolve() {
          return { status: 'verified', evidenceRef };
        },
      },
    });
    const predicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: HEAD_NEW },
    });

    const result = await resolver.resolveCompletion(predicate, candidate([evidenceRef]), {
      leaseId: 'lease-review-2',
      generation: 2,
      catId: 'codex-terra',
      holderThreadId: 'thread-review',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-review',
      tenantScope: 'user-1',
    });

    assert.equal(result.status, 'insufficient');
    assert.equal(result.reason, 'current HEAD projection unavailable');
  });

  it('uses a persisted terminal marker when the projection is not newer', async () => {
    const marker = {
      subjectRef: 'pr:owner/repo#2868',
      state: 'merged',
      evidenceRef: 'github:merged',
      observedAt: 190,
    };
    const { resolver, communityStore } = harness({ marker, object: projection('new', { updatedAt: 180 }) });
    assert.deepEqual(await resolver.resolve('PR:Owner/Repo#2868', 300), {
      terminal: true,
      source: 'marker',
      truth: marker,
    });
    assert.equal(communityStore.reads, 1);
  });

  it('projects fixed PR truth to a persistent merged marker', async () => {
    const { resolver, marks } = harness({ object: projection('fixed') });
    const result = await resolver.resolve('PR:Owner/Repo#2868', 300);
    assert.equal(result.terminal, true);
    assert.equal(result.source, 'community_projection');
    assert.equal(result.truth.state, 'merged');
    assert.equal(result.truth.evidenceRef, 'community:pr:owner/repo#2868:fixed:200');
    assert.equal(marks.length, 1);
  });

  it('treats reported and closed PR projections as terminal', async () => {
    const reported = harness({ object: projection('reported') });
    assert.equal((await reported.resolver.resolve('pr:owner/repo#2868', 300)).truth.state, 'merged');

    const closed = harness({ object: projection('closed') });
    assert.equal((await closed.resolver.resolve('pr:owner/repo#2868', 300)).truth.state, 'closed');
  });

  it('returns active for a known open PR and unknown for unsupported subjects', async () => {
    const active = harness({ object: projection('in_progress') });
    assert.deepEqual(await active.resolver.resolve('pr:owner/repo#2868', 300), {
      terminal: false,
      source: 'community_projection',
      state: 'active',
    });

    const opaque = harness({ object: projection('fixed') });
    assert.deepEqual(await opaque.resolver.resolve('subject:task:T-1', 300), {
      terminal: false,
      source: 'task_store',
      state: 'unknown',
    });
    assert.equal(opaque.communityStore.reads, 0);
  });

  it('binds task admission and completion truth to the same persisted task', async () => {
    const task = {
      id: 'task-1',
      status: 'todo',
      ownerCatId: 'opus',
      threadId: 'thread-task',
      userId: 'user-1',
      updatedAt: 210,
    };
    const { resolver } = harness({ task });
    const predicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'implement',
      subjectRef: 'subject:task:task-1',
      predicate: { kind: 'task_done' },
    });

    assert.deepEqual(await resolver.resolveFreshness(predicate), {
      status: 'verified',
      evidenceRef: 'task:task-1:active:210',
      freshnessKey: 'task:task-1',
      ownerCatId: 'opus',
      holderThreadId: 'thread-task',
      tenantScope: 'user-1',
    });

    const doneTask = { ...task, status: 'done', updatedAt: 240 };
    const done = harness({ task: doneTask }).resolver;
    const snapshot = candidate(['task:task-1:done:240']);
    assert.deepEqual(await done.resolveCompletion(predicate, snapshot), {
      status: 'verified',
      evidenceRef: 'task:task-1:done:240',
      predicateDigest: predicate.digest,
      freshnessKey: predicate.freshnessKey,
      candidateRevision: snapshot.candidateRevision,
      evidenceDigest: snapshot.evidenceDigest,
    });
    assert.equal((await resolver.resolveCompletion(predicate, snapshot)).status, 'mismatch');
  });

  it('treats an already-done task as terminal before a new lease can be admitted', async () => {
    const task = {
      id: 'task-1',
      status: 'done',
      ownerCatId: 'opus',
      threadId: 'thread-task',
      userId: 'user-1',
      updatedAt: 240,
    };
    const { resolver, marks } = harness({ task });

    const result = await resolver.resolve('subject:task:task-1', 250);
    assert.equal(result.terminal, true);
    assert.equal(result.truth.state, 'closed');
    assert.equal(result.truth.evidenceRef, 'task:task-1:done:240');
    assert.equal(marks.length, 1);
  });

  it('retires an older terminal marker when GitHub truth shows the PR reopened', async () => {
    const marker = {
      subjectRef: 'pr:owner/repo#2868',
      state: 'closed',
      evidenceRef: 'github:closed',
      observedAt: 190,
    };
    const { resolver, marks } = harness({ marker, object: projection('in_progress', { updatedAt: 250 }) });
    assert.deepEqual(await resolver.resolve('pr:owner/repo#2868', 300), {
      terminal: false,
      source: 'community_projection',
      state: 'active',
    });
    assert.deepEqual(marks, [
      {
        subjectRef: 'pr:owner/repo#2868',
        state: 'active',
        evidenceRef: 'community:pr:owner/repo#2868:in_progress:250',
        observedAt: 250,
      },
    ]);
  });

  it('falls back to tracking HEAD when community projection lacks externalReview', async () => {
    // Community projection exists but has no externalReview (HEAD not yet observed by coordinator)
    const { resolver } = harness({
      object: projection('in_progress'),
      trackingHead: HEAD_NEW,
    });
    const predicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: HEAD_NEW },
    });
    assert.deepEqual(await resolver.resolveFreshness(predicate), {
      status: 'verified',
      evidenceRef: `tracking:pr:owner/repo#2868:head:${HEAD_NEW}`,
      freshnessKey: predicate.freshnessKey,
    });
  });

  it('returns mismatch when tracking HEAD does not match predicate HEAD', async () => {
    const { resolver } = harness({
      object: projection('in_progress'),
      trackingHead: HEAD_OLD,
    });
    const predicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: HEAD_NEW },
    });
    assert.deepEqual(await resolver.resolveFreshness(predicate), {
      status: 'mismatch',
      reason: 'predicate HEAD is not the tracking-observed current HEAD',
    });
  });

  it('returns insufficient when neither community projection nor tracking has HEAD', async () => {
    const { resolver } = harness({
      object: projection('in_progress'),
      trackingHead: null,
    });
    const predicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: HEAD_NEW },
    });
    assert.deepEqual(await resolver.resolveFreshness(predicate), {
      status: 'insufficient',
      reason: 'current HEAD projection unavailable',
    });
  });

  it('returns insufficient without tracking provider when community projection lacks HEAD', async () => {
    // No tracking provider at all (backwards compatibility)
    const { resolver } = harness({
      object: projection('in_progress'),
    });
    const predicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: HEAD_NEW },
    });
    assert.deepEqual(await resolver.resolveFreshness(predicate), {
      status: 'insufficient',
      reason: 'current HEAD projection unavailable',
    });
  });

  it('rejects non-PR and terminal tracking snapshots even when they retain the matching HEAD', async () => {
    const predicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: HEAD_NEW },
    });
    const inactiveSnapshots = [
      { ...activeTrackingSnapshot(HEAD_NEW), kind: 'issue_tracking' },
      { ...activeTrackingSnapshot(HEAD_NEW), status: 'done' },
      { ...activeTrackingSnapshot(HEAD_NEW), ciPrState: 'merged' },
      { ...activeTrackingSnapshot(HEAD_NEW), reviewPrState: 'closed' },
      { ...activeTrackingSnapshot(HEAD_NEW), closedAt: 300 },
    ];

    for (const trackingSnapshot of inactiveSnapshots) {
      const { resolver } = harness({ object: projection('in_progress'), trackingSnapshot });
      assert.deepEqual(await resolver.resolveFreshness(predicate), {
        status: 'insufficient',
        reason: 'current HEAD projection unavailable',
      });
    }
  });

  it('prefers community projection HEAD over tracking HEAD when both are available', async () => {
    const externalReview = {
      currentHeadSha: HEAD_NEW,
      lastReviewedHeadSha: null,
      delivery: null,
      ci: null,
    };
    const { resolver } = harness({
      object: projection('in_progress', { externalReview }),
      trackingHead: HEAD_OLD,
    });
    const predicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:owner/repo#2868',
      predicate: { kind: 'review_delivered', headSha: HEAD_NEW },
    });
    // Should use community HEAD (HEAD_NEW), not tracking HEAD (HEAD_OLD)
    assert.deepEqual(await resolver.resolveFreshness(predicate), {
      status: 'verified',
      evidenceRef: `community:pr:owner/repo#2868:head:${HEAD_NEW}`,
      freshnessKey: predicate.freshnessKey,
    });
  });
});
