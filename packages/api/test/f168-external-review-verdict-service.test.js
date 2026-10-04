import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { canonicalizeActionTerminalPredicate } from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import { CommunityProjector } from '../dist/domains/community/community-projector.js';
import { ExternalReviewCoordinator } from '../dist/domains/community/external-review/ExternalReviewCoordinator.js';
import {
  ExternalReviewVerdictError,
  ExternalReviewVerdictService,
} from '../dist/domains/community/external-review/ExternalReviewVerdictService.js';

class MemoryEventLog {
  events = [];
  failNextAppend = false;

  async append(event) {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error('event append unavailable');
    }
    const existing = this.events.find((candidate) => candidate.sourceEventId === event.sourceEventId);
    if (existing) return { appended: false, sequence: this.events.indexOf(existing) };
    this.events.push(structuredClone(event));
    return { appended: true, sequence: this.events.length - 1 };
  }

  async read(subjectKey) {
    return this.events.filter((event) => event.subjectKey === subjectKey);
  }

  async listSubjects() {
    return [...new Set(this.events.map((event) => event.subjectKey))];
  }
}

class MemoryObjectStore {
  values = new Map();

  async get(subjectKey) {
    return this.values.get(subjectKey) ?? null;
  }

  async save(projection) {
    this.values.set(projection.subjectKey, structuredClone(projection));
  }

  async listSubjectKeys() {
    return [...this.values.keys()];
  }

  async delete(subjectKey) {
    this.values.delete(subjectKey);
  }
}

const subjectKey = 'pr:acme/widgets#7';
const headSha = 'a'.repeat(40);
const principal = { catId: 'codex-sol', threadId: 'thread-f168' };
const terminalPredicateDigest = canonicalizeActionTerminalPredicate({
  actionFamily: 'review',
  subjectRef: subjectKey,
  predicate: { kind: 'review_delivered', headSha },
}).digest;
const deliveredEvidenceRef = 'github:https://github.com/acme/widgets/pull/7#pullrequestreview-100';

function projection(overrides = {}) {
  return {
    repo: 'acme/widgets',
    type: 'pr',
    number: 7,
    subjectKey,
    state: 'in_progress',
    ownerThreadId: null,
    ownerRole: null,
    nextOwner: 'none',
    lastExternalActivityAt: null,
    lastPublicCommentAt: null,
    linkedIssues: [],
    linkedPrs: [],
    closureWaiver: null,
    appliedEventCount: 6,
    lastRejectedEvent: null,
    deliveryCursor: null,
    createdAt: 1,
    updatedAt: 6,
    externalReview: {
      mode: 'maintainer_review',
      cloudPolicy: 'required',
      lifecycle: 'rereview_required',
      currentHeadSha: headSha,
      headGeneration: 1,
      currentHeadObservedAt: 1,
      lastReviewedHeadSha: null,
      lastReviewedHeadGeneration: null,
      lastDeliveredHeadSha: null,
      lastDeliveredHeadGeneration: null,
      ci: { headSha, headGeneration: 1, status: 'pass', observedAt: 3 },
      cloud: { headSha, headGeneration: 1, status: 'clean', observedAt: 4, reviewId: 71 },
      wake: {
        headSha,
        headGeneration: 1,
        status: 'delivered',
        requestedAt: 5,
        messageId: 'message-1',
        deliveredAt: 6,
      },
      delivery: null,
      reviewerCatId: principal.catId,
      reviewerThreadId: principal.threadId,
      actionLeaseRef: null,
      ...overrides,
    },
  };
}

const deliveredInput = (overrides = {}) => ({
  repoFullName: 'acme/widgets',
  prNumber: 7,
  reviewedHeadSha: headSha,
  verdict: 'approved',
  summary: 'Current HEAD reviewed; no blocking findings.',
  delivery: {
    kind: 'delivered',
    githubUrl: 'https://github.com/acme/widgets/pull/7#pullrequestreview-100',
  },
  principal,
  ...overrides,
});

describe('F168 ExternalReviewVerdictService', () => {
  let eventLog;
  let objectStore;
  let projector;
  let config;
  let currentHead;
  let preflightResult;
  let preflightCalls;
  let userNudgeCount;
  let completions;
  let completionResult;
  let currentHeadFetches;
  let service;

  beforeEach(async () => {
    eventLog = new MemoryEventLog();
    objectStore = new MemoryObjectStore();
    projector = new CommunityProjector(eventLog, objectStore);
    config = {
      repo: 'acme/widgets',
      guardThreadId: 'thread-guard',
      guardCatId: 'opus48',
      reviewMode: 'maintainer_review',
      cloudReviewPolicy: 'required',
      createdAt: 1,
      updatedAt: 1,
    };
    currentHead = headSha;
    preflightResult = { ok: true, reason: 'active' };
    preflightCalls = [];
    userNudgeCount = 0;
    completions = [];
    completionResult = { outcome: 'committed' };
    currentHeadFetches = 0;
    await objectStore.save(projection());
    service = new ExternalReviewVerdictService({
      repoConfigStore: { getByRepo: async () => config },
      eventLog,
      projector,
      objectStore,
      fetchCurrentHead: async () => {
        currentHeadFetches += 1;
        return currentHead;
      },
      preflightLease: async (leaseId, generation, catId, predicateDigest) => {
        preflightCalls.push({ leaseId, generation, catId, terminalPredicateDigest: predicateDigest });
        return preflightResult;
      },
      completeActionLease: async (input) => {
        completions.push(input);
        return completionResult;
      },
      recordUserNudgeRequired: () => {
        userNudgeCount += 1;
      },
      now: () => 10_000,
    });
  });

  async function createLogAheadSubmission(inputOverrides = {}) {
    config = { ...config, cloudReviewPolicy: 'optional' };
    objectStore.values.clear();
    const tracking = { ...principal, userId: 'user-1' };
    const coordinator = new ExternalReviewCoordinator({
      repoConfigStore: { getByRepo: async () => config },
      eventLog,
      projector,
      objectStore,
      now: () => 11_000,
      log: { info() {}, warn() {}, error() {} },
    });
    let failFirstSubmittedApply = true;
    const repairingService = new ExternalReviewVerdictService({
      repoConfigStore: { getByRepo: async () => config },
      eventLog,
      projector: {
        async apply(event) {
          if (event.kind === 'case.review_verdict_submitted' && failFirstSubmittedApply) {
            failFirstSubmittedApply = false;
            throw new Error('simulated pending projection crash');
          }
          await projector.apply(event);
        },
        rebuild: (key) => projector.rebuild(key),
      },
      objectStore,
      fetchCurrentHead: async () => currentHead,
      preflightLease: async () => ({ ok: true, reason: 'active' }),
      completeActionLease: async () => ({ outcome: 'committed' }),
      now: () => 10_000,
    });
    await coordinator.recordCloud(
      { repoFullName: 'acme/widgets', prNumber: 7, headSha, status: 'clean', reviewId: 71 },
      tracking,
    );
    await assert.rejects(
      () => repairingService.record(deliveredInput(inputOverrides)),
      /simulated pending projection crash/,
    );
    return repairingService;
  }

  it('records a delivered proof atomically and retries idempotently', async () => {
    const first = await service.record(deliveredInput());
    const second = await service.record(deliveredInput());

    assert.deepEqual(first.delivery, {
      kind: 'delivered',
      headSha,
      githubUrl: 'https://github.com/acme/widgets/pull/7#pullrequestreview-100',
      deliveredAt: 10_000,
    });
    assert.deepEqual(second, first);
    assert.equal(eventLog.events.length, 1);
    assert.equal(eventLog.events[0].payload.verdict, 'approved');
    assert.equal(eventLog.events[0].payload.summary, 'Current HEAD reviewed; no blocking findings.');

    const stored = await objectStore.get(subjectKey);
    assert.equal(stored.externalReview.lifecycle, 'delivered');
    assert.equal(stored.externalReview.lastReviewedHeadSha, headSha);
    assert.equal(stored.externalReview.lastDeliveredHeadSha, headSha);
  });

  it('records durable pending delivery with server-derived owner and timestamp', async () => {
    const result = await service.record(
      deliveredInput({
        verdict: 'changes_requested',
        summary: 'Blocking finding must be posted.',
        delivery: { kind: 'pending_delivery', reason: 'GitHub write temporarily unavailable' },
      }),
    );

    assert.deepEqual(result.delivery, {
      kind: 'pending_delivery',
      headSha,
      ownerCatId: principal.catId,
      reason: 'GitHub write temporarily unavailable',
      createdAt: 10_000,
    });
    const stored = await objectStore.get(subjectKey);
    assert.equal(stored.externalReview.lifecycle, 'pending_delivery');
    assert.equal(stored.externalReview.lastDeliveredHeadSha, null);
  });

  it('accepts one typed verdict during bounded canonical lag and settles it on the next collector tick', async () => {
    config = { ...config, cloudReviewPolicy: 'optional' };
    await objectStore.save(
      projection({
        cloudPolicy: 'optional',
        lifecycle: 'awaiting_ci',
        ci: { headSha, headGeneration: 1, status: 'pending', observedAt: 9_000 },
        cloud: null,
        wake: null,
      }),
    );

    const first = await service.record(deliveredInput());

    assert.equal(first.lifecycle, 'pending_verification');
    assert.deepEqual(first.verification, {
      status: 'pending',
      reason: 'ci_pending',
      submittedAt: 10_000,
    });
    assert.equal(
      eventLog.events.filter((event) => event.kind === 'case.review_verdict_submitted').length,
      1,
      'one external submission must create one durable pending fact',
    );
    assert.equal(
      eventLog.events.some((event) => event.kind === 'case.review_verdict_recorded'),
      false,
    );

    const coordinator = new ExternalReviewCoordinator({
      repoConfigStore: { getByRepo: async () => config },
      eventLog,
      projector,
      objectStore,
      settlePendingVerdict: (key) => service.settlePending(key),
      now: () => 10_100,
      log: { info() {}, warn() {}, error() {} },
    });
    const collectorResult = await coordinator.recordCi(
      {
        repoFullName: 'acme/widgets',
        prNumber: 7,
        headSha,
        prState: 'open',
        aggregateBucket: 'pass',
        checks: [],
      },
      { ...principal, userId: 'user-1' },
    );

    assert.deepEqual(collectorResult, { kind: 'state_only', reason: 'pending_verdict_settled' });
    assert.equal(eventLog.events.filter((event) => event.kind === 'case.review_verdict_recorded').length, 1);
    assert.equal(currentHeadFetches, 1, 'collector settlement must not perform a live GitHub readiness readback');
    const stored = await objectStore.get(subjectKey);
    assert.equal(stored.externalReview.lifecycle, 'delivered');
    assert.equal(stored.externalReview.pendingVerdict, null);
  });

  it('deduplicates an identical transport replay while canonical verification is pending', async () => {
    await objectStore.save(
      projection({
        lifecycle: 'awaiting_ci',
        ci: { headSha, headGeneration: 1, status: 'pending', observedAt: 9_000 },
        wake: null,
      }),
    );

    const first = await service.record(deliveredInput());
    const duplicate = await service.record(deliveredInput());

    assert.deepEqual(duplicate, first);
    assert.equal(eventLog.events.filter((event) => event.kind === 'case.review_verdict_submitted').length, 1);
  });

  it('invalidates a pending verdict when CI fails so a later rerun cannot settle stale reviewer intent', async () => {
    config = { ...config, cloudReviewPolicy: 'optional' };
    await objectStore.save(
      projection({
        cloudPolicy: 'optional',
        lifecycle: 'awaiting_ci',
        ci: { headSha, headGeneration: 1, status: 'pending', observedAt: 9_000 },
        cloud: null,
        wake: null,
        actionLeaseRef: { leaseId: 'lease-1', generation: 3 },
      }),
    );
    await service.record(deliveredInput({ actionLeaseRef: { leaseId: 'lease-1', generation: 3 } }));
    const coordinator = new ExternalReviewCoordinator({
      repoConfigStore: { getByRepo: async () => config },
      eventLog,
      projector,
      objectStore,
      settlePendingVerdict: (key) => service.settlePending(key),
      now: () => 10_100,
      log: { info() {}, warn() {}, error() {} },
    });

    const result = await coordinator.recordCi(
      {
        repoFullName: 'acme/widgets',
        prNumber: 7,
        headSha,
        prState: 'open',
        aggregateBucket: 'fail',
        checks: [],
      },
      { ...principal, userId: 'user-1' },
    );

    assert.deepEqual(result, { kind: 'state_only', reason: 'ci_failed' });
    assert.equal(
      eventLog.events.some((event) => event.kind === 'case.review_verdict_recorded'),
      false,
    );
    assert.equal((await objectStore.get(subjectKey)).externalReview.pendingVerdict, null);

    const rerun = await coordinator.recordCi(
      {
        repoFullName: 'acme/widgets',
        prNumber: 7,
        headSha,
        prState: 'open',
        aggregateBucket: 'pass',
        checks: [],
      },
      { ...principal, userId: 'user-1' },
    );

    assert.deepEqual(rerun, { kind: 'state_only', reason: 'explicit_wait_required' });
    assert.equal(
      eventLog.events.some((event) => event.kind === 'case.review_verdict_recorded'),
      false,
    );
    assert.deepEqual(completions, []);
  });

  it('persists a post-invalidation resubmission so restart rebuild can settle it', async () => {
    config = { ...config, cloudReviewPolicy: 'optional' };
    objectStore.values.clear();
    let collectorClock = 11_000;
    const makeCoordinator = () =>
      new ExternalReviewCoordinator({
        repoConfigStore: { getByRepo: async () => config },
        eventLog,
        projector,
        objectStore,
        settlePendingVerdict: (key) => service.settlePending(key),
        now: () => ++collectorClock,
        log: { info() {}, warn() {}, error() {} },
      });
    const tracking = { ...principal, userId: 'user-1' };
    const ci = (aggregateBucket) => ({
      repoFullName: 'acme/widgets',
      prNumber: 7,
      headSha,
      prState: 'open',
      aggregateBucket,
      checks: [],
    });

    const coordinator = makeCoordinator();
    assert.deepEqual(
      await coordinator.recordCloud(
        {
          repoFullName: 'acme/widgets',
          prNumber: 7,
          headSha,
          status: 'clean',
          reviewId: 71,
        },
        tracking,
      ),
      { kind: 'state_only', reason: 'ci_not_observed' },
    );

    assert.equal((await service.record(deliveredInput())).lifecycle, 'pending_verification');
    assert.deepEqual(await coordinator.recordCi(ci('fail'), tracking), { kind: 'state_only', reason: 'ci_failed' });
    assert.equal((await objectStore.get(subjectKey)).externalReview.verdictSubmissionEpoch, 1);
    assert.deepEqual(await coordinator.recordCi(ci('pending'), tracking), {
      kind: 'state_only',
      reason: 'ci_pending',
    });
    assert.equal((await service.record(deliveredInput())).lifecycle, 'pending_verification');

    const submitted = eventLog.events.filter((event) => event.kind === 'case.review_verdict_submitted');
    assert.equal(submitted.length, 2, 'the accepted resubmission must append after the invalidating CI fact');
    assert.notEqual(submitted[0].sourceEventId, submitted[1].sourceEventId);
    assert.match(submitted[1].sourceEventId, /:e1:/);

    const restarted = makeCoordinator();
    assert.deepEqual(await restarted.recordCi(ci('pending'), tracking), {
      kind: 'state_only',
      reason: 'ci_pending',
    });
    assert.equal(
      (await objectStore.get(subjectKey)).externalReview.pendingVerdict?.fingerprint.length,
      24,
      'the first post-restart collector pass must rebuild the accepted resubmission',
    );

    assert.deepEqual(await restarted.recordCi(ci('pass'), tracking), {
      kind: 'state_only',
      reason: 'pending_verdict_settled',
    });
    assert.equal(eventLog.events.filter((event) => event.kind === 'case.review_verdict_recorded').length, 1);
  });

  it('rebuilds a log-ahead submission before resubmitting after invalidation', async () => {
    config = { ...config, cloudReviewPolicy: 'optional' };
    objectStore.values.clear();
    let collectorClock = 12_000;
    let failFirstSubmittedApply = true;
    const repairingService = new ExternalReviewVerdictService({
      repoConfigStore: { getByRepo: async () => config },
      eventLog,
      projector: {
        async apply(event) {
          if (event.kind === 'case.review_verdict_submitted' && failFirstSubmittedApply) {
            failFirstSubmittedApply = false;
            throw new Error('simulated pending projection crash');
          }
          await projector.apply(event);
        },
        rebuild: (key) => projector.rebuild(key),
      },
      objectStore,
      fetchCurrentHead: async () => currentHead,
      preflightLease: async () => ({ ok: true, reason: 'active' }),
      completeActionLease: async (input) => {
        completions.push(input);
        return { outcome: 'committed' };
      },
      now: () => 10_000,
    });
    const makeCoordinator = () =>
      new ExternalReviewCoordinator({
        repoConfigStore: { getByRepo: async () => config },
        eventLog,
        projector,
        objectStore,
        settlePendingVerdict: (key) => repairingService.settlePending(key),
        now: () => ++collectorClock,
        log: { info() {}, warn() {}, error() {} },
      });
    const tracking = { ...principal, userId: 'user-1' };
    const ci = (aggregateBucket) => ({
      repoFullName: 'acme/widgets',
      prNumber: 7,
      headSha,
      prState: 'open',
      aggregateBucket,
      checks: [],
    });
    const coordinator = makeCoordinator();
    await coordinator.recordCloud(
      { repoFullName: 'acme/widgets', prNumber: 7, headSha, status: 'clean', reviewId: 71 },
      tracking,
    );

    await assert.rejects(() => repairingService.record(deliveredInput()), /simulated pending projection crash/);
    assert.equal(eventLog.events.filter((event) => event.kind === 'case.review_verdict_submitted').length, 1);
    assert.equal((await objectStore.get(subjectKey)).externalReview.pendingVerdict, null);

    await coordinator.recordCi(ci('fail'), tracking);
    await coordinator.recordCi(ci('pending'), tracking);
    assert.equal((await repairingService.record(deliveredInput())).lifecycle, 'pending_verification');

    const submitted = eventLog.events.filter((event) => event.kind === 'case.review_verdict_submitted');
    assert.equal(submitted.length, 2, 'repair must append the post-invalidation submission after the old durable fact');
    assert.match(submitted[1].sourceEventId, /:e1:/);

    const restarted = makeCoordinator();
    await restarted.recordCi(ci('pending'), tracking);
    assert.equal((await objectStore.get(subjectKey)).externalReview.pendingVerdict?.fingerprint.length, 24);
    assert.deepEqual(await restarted.recordCi(ci('pass'), tracking), {
      kind: 'state_only',
      reason: 'pending_verdict_settled',
    });
    assert.equal(eventLog.events.filter((event) => event.kind === 'case.review_verdict_recorded').length, 1);
  });

  it('revalidates canonical reviewer, mode, and lifecycle before repairing a log-ahead submission', async (t) => {
    const cases = [
      {
        name: 'reviewer reassigned',
        expectedCode: 'wrong_principal',
        event: {
          kind: 'case.external_review_assigned',
          payload: {
            mode: 'maintainer_review',
            cloudPolicy: 'optional',
            reviewerCatId: 'opus5',
            reviewerThreadId: 'thread-opus5',
          },
        },
      },
      {
        name: 'policy changed to observe-only',
        expectedCode: 'observe_only',
        event: {
          kind: 'case.external_review_assigned',
          payload: {
            mode: 'observe_only',
            cloudPolicy: 'optional',
            reviewerCatId: principal.catId,
            reviewerThreadId: principal.threadId,
          },
        },
      },
      {
        name: 'subject became terminal',
        expectedCode: 'subject_terminal',
        event: { kind: 'pr.closed', classification: 'state-changing', payload: {} },
      },
    ];

    for (const testCase of cases) {
      await t.test(testCase.name, async () => {
        eventLog = new MemoryEventLog();
        objectStore = new MemoryObjectStore();
        projector = new CommunityProjector(eventLog, objectStore);
        const repairingService = await createLogAheadSubmission();
        await eventLog.append({
          sourceEventId: `f168:probe:authorization:${testCase.expectedCode}`,
          subjectKey,
          classification: 'informational',
          at: 11_500,
          ...testCase.event,
        });

        await assert.rejects(() => repairingService.record(deliveredInput()), errorCode(testCase.expectedCode));
        assert.equal(eventLog.events.filter((event) => event.kind === 'case.review_verdict_submitted').length, 1);
        assert.equal((await objectStore.get(subjectKey)).externalReview.pendingVerdict, null);
      });
    }
  });

  it('revalidates canonical action-lease custody before repairing a log-ahead submission', async (t) => {
    const oldLease = { leaseId: 'lease-1', generation: 1 };
    for (const testCase of [
      { name: 'new canonical fence is required', initialLease: undefined, expectedCode: 'action_lease_required' },
      {
        name: 'changed canonical fence rejects stale input',
        initialLease: oldLease,
        expectedCode: 'action_lease_mismatch',
      },
    ]) {
      await t.test(testCase.name, async () => {
        eventLog = new MemoryEventLog();
        objectStore = new MemoryObjectStore();
        projector = new CommunityProjector(eventLog, objectStore);
        const inputOverrides = testCase.initialLease ? { actionLeaseRef: testCase.initialLease } : {};
        const repairingService = await createLogAheadSubmission(inputOverrides);
        await eventLog.append({
          sourceEventId: `f168:probe:authorization:${testCase.expectedCode}`,
          subjectKey,
          kind: 'case.external_review_assigned',
          classification: 'informational',
          payload: {
            mode: 'maintainer_review',
            cloudPolicy: 'optional',
            reviewerCatId: principal.catId,
            reviewerThreadId: principal.threadId,
            actionLeaseRef: { leaseId: 'lease-2', generation: 2 },
          },
          at: 11_500,
        });

        await assert.rejects(
          () => repairingService.record(deliveredInput(inputOverrides)),
          errorCode(testCase.expectedCode),
        );
        assert.equal(eventLog.events.filter((event) => event.kind === 'case.review_verdict_submitted').length, 1);
        assert.equal((await objectStore.get(subjectKey)).externalReview.pendingVerdict, null);
      });
    }
  });

  it('fails closed when an ambiguous duplicate pending submission cannot rebuild', async () => {
    config = { ...config, cloudReviewPolicy: 'optional' };
    objectStore.values.clear();
    const coordinator = new ExternalReviewCoordinator({
      repoConfigStore: { getByRepo: async () => config },
      eventLog,
      projector,
      objectStore,
      now: () => 13_000,
      log: { info() {}, warn() {}, error() {} },
    });
    await coordinator.recordCloud(
      { repoFullName: 'acme/widgets', prNumber: 7, headSha, status: 'clean', reviewId: 71 },
      { ...principal, userId: 'user-1' },
    );

    let failFirstSubmittedApply = true;
    const unavailableRepairService = new ExternalReviewVerdictService({
      repoConfigStore: { getByRepo: async () => config },
      eventLog,
      projector: {
        async apply(event) {
          if (event.kind === 'case.review_verdict_submitted' && failFirstSubmittedApply) {
            failFirstSubmittedApply = false;
            throw new Error('simulated pending projection crash');
          }
          await projector.apply(event);
        },
        async rebuild() {
          throw new Error('projection rebuild unavailable');
        },
      },
      objectStore,
      fetchCurrentHead: async () => currentHead,
      preflightLease: async () => ({ ok: true, reason: 'active' }),
      completeActionLease: async () => ({ outcome: 'committed' }),
      now: () => 10_000,
    });

    await assert.rejects(() => unavailableRepairService.record(deliveredInput()), /simulated pending projection crash/);
    await assert.rejects(() => unavailableRepairService.record(deliveredInput()), errorCode('projection_unavailable'));
    assert.equal(eventLog.events.filter((event) => event.kind === 'case.review_verdict_submitted').length, 1);
    assert.equal((await objectStore.get(subjectKey)).externalReview.pendingVerdict, null);
  });

  it('does not report pending verification when apply returns without projecting the durable event', async () => {
    config = { ...config, cloudReviewPolicy: 'optional' };
    objectStore.values.clear();
    const coordinator = new ExternalReviewCoordinator({
      repoConfigStore: { getByRepo: async () => config },
      eventLog,
      projector,
      objectStore,
      now: () => 14_000,
      log: { info() {}, warn() {}, error() {} },
    });
    await coordinator.recordCloud(
      { repoFullName: 'acme/widgets', prNumber: 7, headSha, status: 'clean', reviewId: 71 },
      { ...principal, userId: 'user-1' },
    );
    const nonProjectingService = new ExternalReviewVerdictService({
      repoConfigStore: { getByRepo: async () => config },
      eventLog,
      projector: {
        async apply() {},
        rebuild: (key) => projector.rebuild(key),
      },
      objectStore,
      fetchCurrentHead: async () => currentHead,
      preflightLease: async () => ({ ok: true, reason: 'active' }),
      completeActionLease: async () => ({ outcome: 'committed' }),
      now: () => 10_000,
    });

    await assert.rejects(() => nonProjectingService.record(deliveredInput()), errorCode('projection_unavailable'));
    assert.equal(eventLog.events.filter((event) => event.kind === 'case.review_verdict_submitted').length, 1);
    assert.equal((await objectStore.get(subjectKey)).externalReview.pendingVerdict, null);
  });

  it('converges concurrent identical resubmissions on one event or a typed retry', async () => {
    config = { ...config, cloudReviewPolicy: 'optional' };
    objectStore.values.clear();
    let collectorClock = 15_000;
    const coordinator = new ExternalReviewCoordinator({
      repoConfigStore: { getByRepo: async () => config },
      eventLog,
      projector,
      objectStore,
      settlePendingVerdict: (key) => service.settlePending(key),
      now: () => ++collectorClock,
      log: { info() {}, warn() {}, error() {} },
    });
    const tracking = { ...principal, userId: 'user-1' };
    const ci = (aggregateBucket) => ({
      repoFullName: 'acme/widgets',
      prNumber: 7,
      headSha,
      prState: 'open',
      aggregateBucket,
      checks: [],
    });
    await coordinator.recordCloud(
      { repoFullName: 'acme/widgets', prNumber: 7, headSha, status: 'clean', reviewId: 71 },
      tracking,
    );
    await service.record(deliveredInput());
    await coordinator.recordCi(ci('fail'), tracking);
    await coordinator.recordCi(ci('pending'), tracking);

    const outcomes = await Promise.allSettled([service.record(deliveredInput()), service.record(deliveredInput())]);

    const accepted = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const retryable = outcomes.filter((outcome) => outcome.status === 'rejected');
    assert.equal(accepted.length >= 1, true);
    assert.equal(
      accepted.every((outcome) => outcome.value.lifecycle === 'pending_verification'),
      true,
    );
    assert.equal(
      retryable.every(
        (outcome) =>
          outcome.reason instanceof ExternalReviewVerdictError && outcome.reason.code === 'projection_unavailable',
      ),
      true,
    );
    const submitted = eventLog.events.filter((event) => event.kind === 'case.review_verdict_submitted');
    assert.equal(submitted.length, 2, 'the concurrent retry pair must share one post-invalidation event');
    assert.match(submitted[1].sourceEventId, /:e1:/);
    assert.equal((await objectStore.get(subjectKey)).externalReview.pendingVerdict?.fingerprint.length, 24);
  });

  it('keeps a stale pending-verdict lease as diagnosable waiting instead of an error loop', async () => {
    config = { ...config, cloudReviewPolicy: 'optional' };
    await objectStore.save(
      projection({
        cloudPolicy: 'optional',
        lifecycle: 'awaiting_ci',
        ci: { headSha, headGeneration: 1, status: 'pending', observedAt: 9_000 },
        cloud: null,
        wake: null,
        actionLeaseRef: { leaseId: 'lease-1', generation: 3 },
      }),
    );
    await service.record(deliveredInput({ actionLeaseRef: { leaseId: 'lease-1', generation: 3 } }));
    preflightResult = { ok: false, reason: 'stale_generation' };
    const warnings = [];
    const errors = [];
    const coordinator = new ExternalReviewCoordinator({
      repoConfigStore: { getByRepo: async () => config },
      eventLog,
      projector,
      objectStore,
      settlePendingVerdict: (key) => service.settlePending(key),
      now: () => 10_100,
      log: {
        info() {},
        warn(fields, message) {
          warnings.push({ fields, message });
        },
        error(fields, message) {
          errors.push({ fields, message });
        },
      },
    });

    const result = await coordinator.recordCi(
      {
        repoFullName: 'acme/widgets',
        prNumber: 7,
        headSha,
        prState: 'open',
        aggregateBucket: 'pass',
        checks: [],
      },
      { ...principal, userId: 'user-1' },
    );

    assert.deepEqual(result, { kind: 'state_only', reason: 'explicit_wait_required' });
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].fields.reason, 'stale_action_lease');
    assert.equal(
      eventLog.events.some((event) => event.kind === 'case.review_verdict_recorded'),
      false,
    );
    assert.equal((await objectStore.get(subjectKey)).externalReview.pendingVerdict.fingerprint.length > 0, true);
  });

  it('rejects a conflicting second verdict while one typed submission awaits verification', async () => {
    await objectStore.save(
      projection({
        lifecycle: 'awaiting_ci',
        ci: { headSha, headGeneration: 1, status: 'pending', observedAt: 9_000 },
        wake: null,
      }),
    );
    await service.record(deliveredInput());

    await assert.rejects(
      () => service.record(deliveredInput({ verdict: 'changes_requested', summary: 'A conflicting decision.' })),
      errorCode('verdict_conflict'),
    );
    assert.equal(eventLog.events.filter((event) => event.kind === 'case.review_verdict_submitted').length, 1);
  });

  it('repairs a pending-verdict projection when the event append won but projection apply crashed', async () => {
    config = { ...config, cloudReviewPolicy: 'optional' };
    objectStore.values.clear();
    const coordinator = new ExternalReviewCoordinator({
      repoConfigStore: { getByRepo: async () => config },
      eventLog,
      projector,
      objectStore,
      now: () => 9_000,
      log: { info() {}, warn() {}, error() {} },
    });
    await coordinator.recordCloud(
      { repoFullName: 'acme/widgets', prNumber: 7, headSha, status: 'clean', reviewId: 71 },
      { ...principal, userId: 'user-1' },
    );
    let failOnce = true;
    const repairingService = new ExternalReviewVerdictService({
      repoConfigStore: { getByRepo: async () => config },
      eventLog,
      projector: {
        async apply(event) {
          if (event.kind === 'case.review_verdict_submitted' && failOnce) {
            failOnce = false;
            throw new Error('simulated pending projection crash');
          }
          await projector.apply(event);
        },
        rebuild: (key) => projector.rebuild(key),
      },
      objectStore,
      fetchCurrentHead: async () => currentHead,
      preflightLease: async () => ({ ok: true, reason: 'active' }),
      completeActionLease: async () => ({ outcome: 'committed' }),
      now: () => 10_000,
    });

    await assert.rejects(() => repairingService.record(deliveredInput()), /simulated pending projection crash/);
    const replay = await repairingService.record(deliveredInput());

    assert.equal(replay.lifecycle, 'pending_verification');
    assert.equal(eventLog.events.filter((event) => event.kind === 'case.review_verdict_submitted').length, 1);
    assert.equal((await objectStore.get(subjectKey)).externalReview.pendingVerdict.fingerprint.length, 24);
  });

  it('records explicit operator reminder provenance and increments the user-nudge metric once', async () => {
    await service.record(deliveredInput({ userNudgeRequired: true }));
    await service.record(deliveredInput({ userNudgeRequired: true }));

    assert.equal(eventLog.events.length, 1);
    assert.equal(eventLog.events[0].payload.userNudgeRequired, true);
    assert.equal(userNudgeCount, 1, 'idempotent verdict retries must not double-count one reminder');
  });

  it('records the same SHA verdict again when it belongs to a later HEAD generation', async () => {
    await service.record(deliveredInput());
    await objectStore.save(
      projection({
        headGeneration: 3,
        currentHeadObservedAt: 20,
        lastReviewedHeadSha: headSha,
        lastReviewedHeadGeneration: 1,
        lastDeliveredHeadSha: headSha,
        lastDeliveredHeadGeneration: 1,
        ci: { headSha, headGeneration: 3, status: 'pass', observedAt: 21 },
        cloud: { headSha, headGeneration: 3, status: 'clean', observedAt: 22, reviewId: 72 },
        wake: {
          headSha,
          headGeneration: 3,
          status: 'delivered',
          requestedAt: 23,
          messageId: 'message-3',
          deliveredAt: 24,
        },
        delivery: null,
        lifecycle: 'rereview_required',
      }),
    );

    await service.record(deliveredInput());

    assert.equal(eventLog.events.length, 2);
    assert.notEqual(eventLog.events[0].sourceEventId, eventLog.events[1].sourceEventId);
    assert.equal(eventLog.events[1].payload.headGeneration, 3);
    const stored = await objectStore.get(subjectKey);
    assert.equal(stored.externalReview.lastReviewedHeadGeneration, 3);
    assert.equal(stored.externalReview.lastDeliveredHeadGeneration, 3);
  });

  it('rejects pending delivery after proof is already canonical without appending a regressive fact', async () => {
    await service.record(deliveredInput());

    await assert.rejects(
      () =>
        service.record(
          deliveredInput({
            delivery: { kind: 'pending_delivery', reason: 'A later retry lost its GitHub response' },
          }),
        ),
      errorCode('delivery_regression'),
    );

    assert.equal(eventLog.events.length, 1, 'rejected regression must not enter the append-only truth log');
    const stored = await objectStore.get(subjectKey);
    assert.equal(stored.externalReview.lifecycle, 'delivered');
    assert.equal(stored.externalReview.delivery.kind, 'delivered');
  });

  it('rejects a stale reviewed head', async () => {
    currentHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    await assert.rejects(() => service.record(deliveredInput()), errorCode('stale_head'));
    assert.equal(eventLog.events.length, 0);
  });

  it('rejects observe-only repositories and the wrong reviewer principal', async () => {
    config = { ...config, reviewMode: 'observe_only' };
    await assert.rejects(() => service.record(deliveredInput()), errorCode('observe_only'));

    config = { ...config, reviewMode: 'maintainer_review' };
    await assert.rejects(
      () => service.record(deliveredInput({ principal: { catId: 'opus48', threadId: principal.threadId } })),
      errorCode('wrong_principal'),
    );
  });

  it('rejects GitHub proof from another PR or without a review/comment anchor', async () => {
    await assert.rejects(
      () =>
        service.record(
          deliveredInput({
            delivery: { kind: 'delivered', githubUrl: 'https://github.com/acme/widgets/pull/8#issuecomment-100' },
          }),
        ),
      errorCode('invalid_delivery_proof'),
    );
    await assert.rejects(
      () =>
        service.record(
          deliveredInput({ delivery: { kind: 'delivered', githubUrl: 'https://github.com/acme/widgets/pull/7' } }),
        ),
      errorCode('invalid_delivery_proof'),
    );
  });

  it('fails closed when the canonical action lease is missing or stale', async () => {
    await objectStore.save(projection({ actionLeaseRef: { leaseId: 'lease-1', generation: 2 } }));

    await assert.rejects(() => service.record(deliveredInput()), errorCode('action_lease_required'));

    preflightResult = { ok: false, reason: 'stale_generation' };
    await assert.rejects(
      () => service.record(deliveredInput({ actionLeaseRef: { leaseId: 'lease-1', generation: 2 } })),
      errorCode('stale_action_lease'),
    );
  });

  it('turns a delivered current-HEAD verdict into typed action completion evidence', async () => {
    await objectStore.save(projection({ actionLeaseRef: { leaseId: 'lease-1', generation: 2 } }));

    await service.record(deliveredInput({ actionLeaseRef: { leaseId: 'lease-1', generation: 2 } }));

    assert.deepEqual(completions, [
      {
        leaseId: 'lease-1',
        generation: 2,
        catId: principal.catId,
        evidenceRefs: [deliveredEvidenceRef],
        now: 10_000,
      },
    ]);

    preflightResult = { ok: true, reason: 'verified_success' };
    await service.record(deliveredInput({ actionLeaseRef: { leaseId: 'lease-1', generation: 2 } }));
    assert.equal(completions.length, 2, 'idempotent verdict retry must re-close the exact lease generation');
  });

  it('does not durably record delivery when the coupled action completion is not committed', async () => {
    await objectStore.save(projection({ actionLeaseRef: { leaseId: 'lease-1', generation: 2 } }));
    completionResult = { outcome: 'stale' };

    await assert.rejects(
      () => service.record(deliveredInput({ actionLeaseRef: { leaseId: 'lease-1', generation: 2 } })),
      errorCode('stale_action_lease'),
    );

    assert.equal(eventLog.events.length, 0, 'a non-committed lease completion must leave no delivered event');
    assert.equal((await objectStore.get(subjectKey)).externalReview.delivery, null);
  });

  it('retries event durability after the exact holder lease was already completed', async () => {
    await objectStore.save(projection({ actionLeaseRef: { leaseId: 'lease-1', generation: 2 } }));
    eventLog.failNextAppend = true;

    await assert.rejects(() =>
      service.record(deliveredInput({ actionLeaseRef: { leaseId: 'lease-1', generation: 2 } })),
    );
    assert.equal(completions.length, 1, 'lease completion must happen before the event append attempt');
    assert.equal(eventLog.events.length, 0);

    preflightResult = { ok: true, reason: 'verified_success' };
    const retried = await service.record(deliveredInput({ actionLeaseRef: { leaseId: 'lease-1', generation: 2 } }));

    assert.equal(retried.lifecycle, 'delivered');
    assert.equal(completions.length, 2, 'same-fence completion replay remains idempotent');
    assert.equal(eventLog.events.length, 1);
  });

  it('rejects pending delivery when custody succeeded before the verdict event became durable', async () => {
    await objectStore.save(projection({ actionLeaseRef: { leaseId: 'lease-1', generation: 2 } }));
    eventLog.failNextAppend = true;

    await assert.rejects(() =>
      service.record(deliveredInput({ actionLeaseRef: { leaseId: 'lease-1', generation: 2 } })),
    );
    assert.equal(completions.length, 1);
    assert.equal(eventLog.events.length, 0);

    preflightResult = { ok: true, reason: 'verified_success' };
    await assert.rejects(
      () =>
        service.record(
          deliveredInput({
            actionLeaseRef: { leaseId: 'lease-1', generation: 2 },
            delivery: { kind: 'pending_delivery', reason: 'A retry lost the GitHub response' },
          }),
        ),
      errorCode('delivery_regression'),
    );

    assert.equal(completions.length, 1, 'a regressive pending retry must not touch the completed custody fence');
    assert.equal(eventLog.events.length, 0, 'a regressive pending retry must not enter the event log');
  });

  it('preflights and completes a supplied action lease when the review projection has no stored fence', async () => {
    await service.record(deliveredInput({ actionLeaseRef: { leaseId: 'lease-1', generation: 2 } }));

    assert.deepEqual(preflightCalls, [
      { leaseId: 'lease-1', generation: 2, catId: principal.catId, terminalPredicateDigest },
    ]);
    assert.deepEqual(completions, [
      {
        leaseId: 'lease-1',
        generation: 2,
        catId: principal.catId,
        evidenceRefs: [deliveredEvidenceRef],
        now: 10_000,
      },
    ]);
  });

  it('rejects a stale supplied action lease before recording a verdict without a stored fence', async () => {
    preflightResult = { ok: false, reason: 'stale_generation' };

    await assert.rejects(
      () => service.record(deliveredInput({ actionLeaseRef: { leaseId: 'lease-1', generation: 2 } })),
      errorCode('stale_action_lease'),
    );

    assert.deepEqual(preflightCalls, [
      { leaseId: 'lease-1', generation: 2, catId: principal.catId, terminalPredicateDigest },
    ]);
    assert.equal(eventLog.events.length, 0);
    assert.equal(completions.length, 0);
  });

  it('rejects terminal or not-ready projections', async () => {
    await objectStore.save(projection({ lifecycle: 'terminal' }));
    await assert.rejects(() => service.record(deliveredInput()), errorCode('subject_terminal'));

    await objectStore.save(projection({ lifecycle: 'awaiting_ci' }));
    await assert.rejects(() => service.record(deliveredInput()), errorCode('head_not_ready'));
  });

  it('rejects a submission when canonical CI already proves the HEAD insufficient', async () => {
    await objectStore.save(
      projection({
        lifecycle: 'awaiting_ci',
        ci: { headSha, headGeneration: 1, status: 'fail', observedAt: 9_000 },
        cloud: null,
        wake: null,
      }),
    );

    await assert.rejects(() => service.record(deliveredInput()), errorCode('head_not_ready'));
    assert.equal(eventLog.events.length, 0);
  });

  it('bootstraps aggregate for retro-triaged PR with no externalReview projection', async () => {
    // Simulate a retro-triaged PR: projection exists from canonical routing
    // events but externalReview is null because ExternalReviewCoordinator
    // .initialize() was never called (CI poller hasn't run for this PR yet).
    // Seed through canonical events so rebuild reconstructs proper ownership.
    objectStore.values.clear();
    await eventLog.append({
      sourceEventId: `routed:${subjectKey}:${principal.threadId}`,
      subjectKey,
      kind: 'case.routed',
      classification: 'state-changing',
      payload: {
        ownerThreadId: principal.threadId,
        ownerRole: principal.catId,
      },
      at: 1,
    });

    // Should bootstrap the aggregate (emit initialization events) and accept
    // the verdict as pending_verification (CI not yet observed)
    const result = await service.record(deliveredInput());

    assert.equal(result.subjectKey, subjectKey);
    assert.equal(result.headSha, headSha);
    assert.equal(result.verdict, 'approved');
    // After bootstrap, CI hasn't been observed yet, so lifecycle must be
    // exactly pending_verification (ci_not_observed) — accepting 'delivered'
    // would mask a premature-delivery regression.
    assert.equal(result.lifecycle, 'pending_verification');

    // Exact verification contract: pending with ci_not_observed at service now()
    assert.deepStrictEqual(result.verification, {
      status: 'pending',
      reason: 'ci_not_observed',
      submittedAt: 10_000,
    });

    // Verify generic case state preserved after bootstrap: ownership fields
    // AND state must survive the bootstrap event emission (not reset to null
    // or 'new'). case.routed transitions to 'routed'; a future rebuild/reset
    // regression would produce 'new' with null ownership.
    const afterBootstrap = await objectStore.get(subjectKey);
    assert.equal(afterBootstrap.state, 'routed');
    assert.equal(afterBootstrap.ownerThreadId, principal.threadId);
    assert.equal(afterBootstrap.ownerRole, principal.catId);
  });

  it('bootstrap fails closed when no projection exists at all', async () => {
    // No projection = no ownerThreadId to verify caller against → fail closed.
    // This is the no-durable-authority case: bootstrap must not mint reviewer
    // identity from the submitter's own principal.
    objectStore.values.clear();

    await assert.rejects(() => service.record(deliveredInput()), errorCode('projection_unavailable'));
    // No events should be appended when failing closed before bootstrap
    assert.equal(eventLog.events.length, 0);
  });

  it('bootstrap rejects caller with different ownerThreadId', async () => {
    // Canonical routing event assigns ownership to a different thread/cat →
    // caller is not the case owner → wrong_principal. Seeded through events
    // so rebuild reconstructs the correct canonical ownership.
    objectStore.values.clear();
    await eventLog.append({
      sourceEventId: `routed:${subjectKey}:thread-other`,
      subjectKey,
      kind: 'case.routed',
      classification: 'state-changing',
      payload: { ownerThreadId: 'thread-other', ownerRole: 'other-cat' },
      at: 1,
    });

    await assert.rejects(() => service.record(deliveredInput()), errorCode('wrong_principal'));
    // Only the seeded routed event — no bootstrap events should be appended
    assert.equal(eventLog.events.length, 1);
  });

  it('bootstrap rejects caller when projection ownerThreadId is null', async () => {
    // Projection exists (from triage) but ownerThreadId/ownerRole are null
    // (ownership not yet established by routing) → no durable authority to
    // verify against → fail closed. Seeded through case.triaged event which
    // creates the projection without setting ownership fields.
    objectStore.values.clear();
    await eventLog.append({
      sourceEventId: `triaged:${subjectKey}`,
      subjectKey,
      kind: 'case.triaged',
      classification: 'state-changing',
      payload: { threadId: 'thread-triage', dispatchedAt: 1 },
      at: 1,
    });

    await assert.rejects(() => service.record(deliveredInput()), errorCode('projection_unavailable'));
    // Only the seeded triaged event — no bootstrap events should be appended
    assert.equal(eventLog.events.length, 1);
  });

  it('bootstrap rejects same owner thread with different catId', async () => {
    // Reproduction P1-R2a: ownerRole stores the assigned catId. A different cat
    // on the same thread must not be accepted — checking only ownerThreadId
    // is insufficient. ownerRole must also match input.principal.catId.
    // Seeded through canonical events so rebuild reconstructs ownership.
    objectStore.values.clear();
    await eventLog.append({
      sourceEventId: `routed:${subjectKey}:same-thread-diff-cat`,
      subjectKey,
      kind: 'case.routed',
      classification: 'state-changing',
      payload: { ownerThreadId: principal.threadId, ownerRole: 'other-cat' },
      at: 1,
    });

    await assert.rejects(() => service.record(deliveredInput()), errorCode('wrong_principal'));
    // Only the seeded routed event — no bootstrap events should be appended
    assert.equal(eventLog.events.length, 1);
  });

  it('bootstrap rejects stale pre-rebuild owner after ownership change', async () => {
    // Reproduction P1-R2b: pre-rebuild projection names principal as owner,
    // but event log records that ownership was transferred to a different cat.
    // Rebuild replays the routed event, producing a projection with the new
    // owner. Using pre-rebuild data would incorrectly accept the old caller.
    // Direct-save projection is stale cache; canonical event is the truth.
    await objectStore.save({
      repo: 'acme/widgets',
      type: 'pr',
      number: 7,
      subjectKey,
      state: 'in_progress',
      ownerThreadId: principal.threadId,
      ownerRole: principal.catId,
      nextOwner: 'none',
      lastExternalActivityAt: null,
      lastPublicCommentAt: null,
      linkedIssues: [],
      linkedPrs: [],
      closureWaiver: null,
      appliedEventCount: 2,
      lastRejectedEvent: null,
      deliveryCursor: null,
      createdAt: 1,
      updatedAt: 2,
      externalReview: null,
    });
    // Canonical event records ownership transferred to a different cat —
    // rebuild will replay this, producing new owner on the projection.
    await eventLog.append({
      sourceEventId: `routed:${subjectKey}:new-owner`,
      subjectKey,
      kind: 'case.routed',
      classification: 'state-changing',
      payload: { ownerThreadId: 'thread-new-owner', ownerRole: 'new-cat' },
      at: 100,
    });

    await assert.rejects(() => service.record(deliveredInput()), errorCode('wrong_principal'));
    // Only the seeded routed event — no bootstrap events should be appended
    assert.equal(eventLog.events.length, 1);
  });

  it('bootstrap computes correct generation for stale HEAD at g2', async () => {
    // Events produce an aggregate at g2 with an old SHA. Bootstrap should
    // compute generation 3 for the new HEAD, not hardcode g=1 (which would
    // be rejected as stale by applyHeadObserved monotonicity enforcement).
    const oldHeadSha = 'b'.repeat(40);
    const secondOldHeadSha = 'c'.repeat(40);

    // Seed canonical events in the event log so Phase 1 rebuild can reconstruct
    await eventLog.append({
      sourceEventId: `f168:external-review-assigned:${subjectKey}:1`,
      subjectKey,
      kind: 'case.external_review_assigned',
      classification: 'informational',
      payload: {
        mode: 'maintainer_review',
        cloudPolicy: 'required',
        reviewerCatId: principal.catId,
        reviewerThreadId: principal.threadId,
      },
      at: 1000,
    });
    await eventLog.append({
      sourceEventId: `f168:head:${subjectKey}:g1:${oldHeadSha}`,
      subjectKey,
      kind: 'case.head_observed',
      classification: 'informational',
      payload: { headSha: oldHeadSha, headGeneration: 1 },
      at: 1001,
    });
    await eventLog.append({
      sourceEventId: `f168:head:${subjectKey}:g2:${secondOldHeadSha}`,
      subjectKey,
      kind: 'case.head_observed',
      classification: 'informational',
      payload: { headSha: secondOldHeadSha, headGeneration: 2 },
      at: 1002,
    });

    // Seed projection at g2 (stale relative to current GitHub HEAD)
    await objectStore.save({
      repo: 'acme/widgets',
      type: 'pr',
      number: 7,
      subjectKey,
      state: 'in_progress',
      ownerThreadId: principal.threadId,
      ownerRole: null,
      nextOwner: 'none',
      lastExternalActivityAt: null,
      lastPublicCommentAt: null,
      linkedIssues: [],
      linkedPrs: [],
      closureWaiver: null,
      appliedEventCount: 3,
      lastRejectedEvent: null,
      deliveryCursor: null,
      createdAt: 1,
      updatedAt: 1002,
      externalReview: {
        mode: 'maintainer_review',
        cloudPolicy: 'required',
        lifecycle: 'awaiting_ci',
        currentHeadSha: secondOldHeadSha,
        headGeneration: 2,
        currentHeadObservedAt: 1002,
        lastReviewedHeadSha: null,
        lastReviewedHeadGeneration: null,
        lastDeliveredHeadSha: null,
        lastDeliveredHeadGeneration: null,
        ci: null,
        cloud: null,
        wake: null,
        delivery: null,
        verdictSubmissionEpoch: 0,
        pendingVerdict: null,
        reviewerCatId: principal.catId,
        reviewerThreadId: principal.threadId,
        actionLeaseRef: null,
      },
    });

    const result = await service.record(deliveredInput());

    assert.equal(result.subjectKey, subjectKey);
    assert.equal(result.headSha, headSha);
    assert.equal(result.verdict, 'approved');
    assert.equal(result.lifecycle, 'pending_verification');

    // Verify the head event was appended at g3, not g1
    const headEvents = eventLog.events.filter((e) => e.kind === 'case.head_observed' && e.payload.headSha === headSha);
    assert.equal(headEvents.length, 1);
    assert.equal(headEvents[0].payload.headGeneration, 3);
  });

  it('coordinator-admitted case succeeds without case.routed (projector ownership path)', async () => {
    // When the coordinator HAS run, case.external_review_assigned is in the event log.
    // The projector fix projects ownerThreadId/ownerRole from that event, enabling
    // verdict bootstrap Case 1 to verify caller authority from durable projection fields.
    objectStore.values.clear();

    // Seed ONLY case.external_review_assigned — no case.routed, no case.triaged.
    await eventLog.append({
      sourceEventId: `f168:external-review-assigned:${subjectKey}:${config.updatedAt}`,
      subjectKey,
      kind: 'case.external_review_assigned',
      classification: 'informational',
      payload: {
        mode: 'maintainer_review',
        cloudPolicy: config.cloudReviewPolicy,
        reviewerCatId: principal.catId,
        reviewerThreadId: principal.threadId,
      },
      at: 1,
    });

    const result = await service.record(deliveredInput());

    assert.equal(result.subjectKey, subjectKey);
    assert.equal(result.headSha, headSha);
    assert.equal(result.verdict, 'approved');
    assert.equal(result.lifecycle, 'pending_verification');

    // Verify ownership was projected from case.external_review_assigned
    const afterVerdict = await objectStore.get(subjectKey);
    assert.equal(afterVerdict.ownerThreadId, principal.threadId);
    assert.equal(afterVerdict.ownerRole, principal.catId);
  });

  it('tracker-admitted case succeeds without coordinator initialization (clowder-ai#1511 regression)', async () => {
    // Regression: clowder-ai#1511, case mua8zwyi3sg4ds97.
    //
    // Root cause: PR subjects never receive case.routed or case.bootstrap events
    // (both are issue-only). When the ExternalReviewCoordinator has not yet run
    // (no case.external_review_assigned in the event log), rebuild produces no
    // aggregate, and bootstrap Case 1 finds no ownerThreadId/ownerRole on the
    // projection → 503 projection_unavailable.
    //
    // The cat registered a bounded tracker via register-pr-tracking (callback-auth
    // verified), polled CI to terminal-green, did a GitHub review, and called
    // record_external_review_verdict. The coordinator's recordCi() was either not
    // wired or failed silently, so no community events exist for this subject.
    //
    // Fix: bootstrap Case 1 tier 2 verifies authority from the durable tracker
    // task when projection-level ownership is absent.
    //
    // Shape: empty event log + matching tracker admission → verdict accepted as
    // pending_verification without a duplicate GitHub review.
    objectStore.values.clear();

    // Empty event log — NO case.external_review_assigned, NO case.routed, NO case.bootstrap.
    // This is the actual #1511 state: the coordinator never ran for this PR.
    assert.equal(eventLog.events.length, 0, 'precondition: event log must be empty');

    // Configure tracker-based authority verification (simulates a matching PR tracker
    // registered via callback-auth-verified register-pr-tracking).
    service = new ExternalReviewVerdictService({
      repoConfigStore: { getByRepo: async () => config },
      eventLog,
      projector,
      objectStore,
      fetchCurrentHead: async () => currentHead,
      preflightLease: async (leaseId, generation, catId, predicateDigest) => {
        preflightCalls.push({ leaseId, generation, catId, terminalPredicateDigest: predicateDigest });
        return preflightResult;
      },
      completeActionLease: async (input) => {
        completions.push(input);
        return completionResult;
      },
      recordUserNudgeRequired: () => {
        userNudgeCount += 1;
      },
      verifyDurableReviewerAdmission: async (sk, catId, threadId) => {
        // Simulate: tracker task exists for this subject with matching cat/thread
        return sk === subjectKey && catId === principal.catId && threadId === principal.threadId;
      },
    });

    const result = await service.record(deliveredInput());

    assert.equal(result.subjectKey, subjectKey);
    assert.equal(result.headSha, headSha);
    assert.equal(result.verdict, 'approved');
    // No CI observed (coordinator never ran), so lifecycle is pending_verification
    assert.equal(result.lifecycle, 'pending_verification');

    // Verify the bootstrap emitted case.external_review_assigned to the event log
    const assignmentEvents = eventLog.events.filter((e) => e.kind === 'case.external_review_assigned');
    assert.equal(assignmentEvents.length, 1, 'bootstrap must emit assignment event');
    assert.equal(assignmentEvents[0].payload.reviewerCatId, principal.catId);
    assert.equal(assignmentEvents[0].payload.reviewerThreadId, principal.threadId);

    // Verify ownership is projected after bootstrap
    const afterVerdict = await objectStore.get(subjectKey);
    assert.equal(
      afterVerdict.ownerThreadId,
      principal.threadId,
      'ownerThreadId must be projected from bootstrap assignment',
    );
    assert.equal(afterVerdict.ownerRole, principal.catId, 'ownerRole must be projected from bootstrap assignment');
  });

  it('bootstrap Case 1 rejects mismatched tracker admission (fail-closed #1511)', async () => {
    // Same scenario as #1511 but the tracker is owned by a different cat.
    // Must fail with projection_unavailable (fail-closed).
    objectStore.values.clear();
    assert.equal(eventLog.events.length, 0, 'precondition: event log must be empty');

    service = new ExternalReviewVerdictService({
      repoConfigStore: { getByRepo: async () => config },
      eventLog,
      projector,
      objectStore,
      fetchCurrentHead: async () => currentHead,
      preflightLease: async () => preflightResult,
      completeActionLease: async (input) => {
        completions.push(input);
        return completionResult;
      },
      verifyDurableReviewerAdmission: async (sk, catId, threadId) => {
        // Tracker exists but owned by a different cat
        return sk === subjectKey && catId === 'other-cat' && threadId === 'other-thread';
      },
    });

    await assert.rejects(() => service.record(deliveredInput()), errorCode('projection_unavailable'));
  });

  it('bootstrap Case 1 rejects when no tracker exists (fail-closed #1511)', async () => {
    // No tracker, no projection ownership — must fail with projection_unavailable.
    objectStore.values.clear();
    assert.equal(eventLog.events.length, 0, 'precondition: event log must be empty');

    service = new ExternalReviewVerdictService({
      repoConfigStore: { getByRepo: async () => config },
      eventLog,
      projector,
      objectStore,
      fetchCurrentHead: async () => currentHead,
      preflightLease: async () => preflightResult,
      completeActionLease: async (input) => {
        completions.push(input);
        return completionResult;
      },
      verifyDurableReviewerAdmission: async () => false, // No matching tracker
    });

    await assert.rejects(() => service.record(deliveredInput()), errorCode('projection_unavailable'));
  });

  it('bootstrap Case 1 rejects when verifyDurableReviewerAdmission not configured (fail-closed)', async () => {
    // Backward compatibility: when verifyDurableReviewerAdmission is not provided,
    // the existing 503 behavior must be preserved for PR subjects without ownership.
    objectStore.values.clear();
    assert.equal(eventLog.events.length, 0, 'precondition: event log must be empty');

    // Use the default service (no verifyDurableReviewerAdmission)
    await assert.rejects(() => service.record(deliveredInput()), errorCode('projection_unavailable'));
  });

  it('bootstrap Case 1 rejects generic work task with matching subject (authority-minting guard #1511)', async () => {
    // A generic 'work' task can legitimately own a pr: subject (entrusted work),
    // but was never admitted by register-pr-tracking's callback auth.
    // It MUST NOT pass Tier 2 — otherwise a non-callback-authorized task would
    // mint reviewer authority and reopen the Case 1 authority gap.
    objectStore.values.clear();
    assert.equal(eventLog.events.length, 0, 'precondition: event log must be empty');

    // Simulate the FIXED runtime wiring: taskStore returns a matching 'work' task,
    // but the kind filter rejects it.
    const mockTaskStore = {
      task: {
        kind: 'work', // NOT pr_tracking — this is the attack vector
        ownerCatId: principal.catId,
        threadId: principal.threadId,
        subject: subjectKey,
      },
    };

    service = new ExternalReviewVerdictService({
      repoConfigStore: { getByRepo: async () => config },
      eventLog,
      projector,
      objectStore,
      fetchCurrentHead: async () => currentHead,
      preflightLease: async () => preflightResult,
      completeActionLease: async (input) => {
        completions.push(input);
        return completionResult;
      },
      verifyDurableReviewerAdmission: async (sk, catId, threadId) => {
        // Reproduces the fixed runtime wiring from index.ts:
        // Only pr_tracking tasks constitute durable admission.
        const task = sk === subjectKey ? mockTaskStore.task : null;
        return task !== null && task.kind === 'pr_tracking' && task.ownerCatId === catId && task.threadId === threadId;
      },
    });

    // Must fail: generic work task cannot mint reviewer authority
    await assert.rejects(() => service.record(deliveredInput()), errorCode('projection_unavailable'));
  });

  it('bootstrap Case 1 accepts pr_tracking task with matching subject (#1511 happy path)', async () => {
    // A pr_tracking task registered via callback-auth register-pr-tracking
    // is the legitimate durable admission source for Tier 2.
    objectStore.values.clear();
    assert.equal(eventLog.events.length, 0, 'precondition: event log must be empty');

    const mockTaskStore = {
      task: {
        kind: 'pr_tracking', // callback-auth-verified admission
        ownerCatId: principal.catId,
        threadId: principal.threadId,
        subject: subjectKey,
      },
    };

    service = new ExternalReviewVerdictService({
      repoConfigStore: { getByRepo: async () => config },
      eventLog,
      projector,
      objectStore,
      fetchCurrentHead: async () => currentHead,
      preflightLease: async (leaseId, generation, catId, predicateDigest) => {
        preflightCalls.push({ leaseId, generation, catId, terminalPredicateDigest: predicateDigest });
        return preflightResult;
      },
      completeActionLease: async (input) => {
        completions.push(input);
        return completionResult;
      },
      recordUserNudgeRequired: () => {
        userNudgeCount += 1;
      },
      verifyDurableReviewerAdmission: async (sk, catId, threadId) => {
        // Reproduces the fixed runtime wiring from index.ts:
        const task = sk === subjectKey ? mockTaskStore.task : null;
        return task !== null && task.kind === 'pr_tracking' && task.ownerCatId === catId && task.threadId === threadId;
      },
    });

    const result = await service.record(deliveredInput());

    assert.equal(result.subjectKey, subjectKey);
    assert.equal(result.lifecycle, 'pending_verification');

    // Verify bootstrap emitted assignment
    const assignmentEvents = eventLog.events.filter((e) => e.kind === 'case.external_review_assigned');
    assert.equal(assignmentEvents.length, 1, 'bootstrap must emit assignment event');
  });

  it('bootstrap preserves fail-closed for unconfigured repos', async () => {
    // No repo config at all — should still fail with not_configured
    config = null;
    objectStore.values.clear();

    await assert.rejects(() => service.record(deliveredInput()), errorCode('not_configured'));
  });

  it('bootstrap preserves fail-closed for stale HEAD', async () => {
    // Projection has no externalReview, but GitHub HEAD doesn't match
    objectStore.values.clear();
    currentHead = 'b'.repeat(40);

    await assert.rejects(() => service.record(deliveredInput()), errorCode('stale_head'));
  });
});

function errorCode(code) {
  return (error) => error instanceof ExternalReviewVerdictError && error.code === code;
}
