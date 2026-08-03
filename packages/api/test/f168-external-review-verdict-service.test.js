import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { canonicalizeActionTerminalPredicate } from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import { CommunityProjector } from '../dist/domains/community/community-projector.js';
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
    await objectStore.save(projection());
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
      now: () => 10_000,
    });
  });

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
});

function errorCode(code) {
  return (error) => error instanceof ExternalReviewVerdictError && error.code === code;
}
