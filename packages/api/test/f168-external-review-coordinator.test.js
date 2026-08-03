import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { CommunityProjector } from '../dist/domains/community/community-projector.js';
import { ExternalReviewCoordinator } from '../dist/domains/community/external-review/ExternalReviewCoordinator.js';

class MemoryEventLog {
  events = [];

  async append(event) {
    if (this.events.some((candidate) => candidate.sourceEventId === event.sourceEventId)) {
      return { appended: false, sequence: -1 };
    }
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

const tracking = {
  threadId: 'thread-f168',
  catId: 'codex-sol',
  userId: 'user-1',
};

const ci = (overrides = {}) => ({
  repoFullName: 'acme/widgets',
  prNumber: 7,
  headSha: 'head-7',
  prState: 'open',
  aggregateBucket: 'pass',
  checks: [],
  ...overrides,
});

describe('F168 ExternalReviewCoordinator', () => {
  let eventLog;
  let objectStore;
  let projector;
  let configs;
  let deliveries;
  let coordinator;
  let clock;

  beforeEach(() => {
    eventLog = new MemoryEventLog();
    objectStore = new MemoryObjectStore();
    projector = new CommunityProjector(eventLog, objectStore);
    configs = new Map();
    deliveries = new Map();
    clock = 1_000;
    coordinator = new ExternalReviewCoordinator({
      repoConfigStore: { getByRepo: async (repo) => configs.get(repo) ?? null },
      eventLog,
      projector,
      objectStore,
      now: () => ++clock,
      deliverReady: async (input) => {
        const existing = deliveries.get(input.idempotencyKey);
        if (existing) return existing;
        const result = { messageId: `message-${deliveries.size + 1}`, content: input.content };
        deliveries.set(input.idempotencyKey, result);
        return result;
      },
      log: { info() {}, warn() {}, error() {} },
    });
  });

  const configure = (overrides = {}) => {
    configs.set('acme/widgets', {
      repo: 'acme/widgets',
      guardThreadId: 'thread-guard',
      guardCatId: 'opus48',
      reviewMode: 'maintainer_review',
      cloudReviewPolicy: 'required',
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    });
  };

  it('keeps CI pass + required cloud running state-only, then wakes once when cloud is clean', async () => {
    configure();

    const ciResult = await coordinator.recordCi(ci(), tracking);
    assert.deepEqual(ciResult, { kind: 'state_only', reason: 'cloud_review_required' });
    assert.equal(deliveries.size, 0);

    const running = await coordinator.recordCloud(
      {
        repoFullName: 'acme/widgets',
        prNumber: 7,
        headSha: 'head-7',
        status: 'running',
        triggerCommentId: 70,
      },
      tracking,
    );
    assert.deepEqual(running, { kind: 'state_only', reason: 'cloud_review_running' });
    assert.equal(deliveries.size, 0);

    const clean = await coordinator.recordCloud(
      {
        repoFullName: 'acme/widgets',
        prNumber: 7,
        headSha: 'head-7',
        status: 'clean',
        triggerCommentId: 70,
        reviewId: 71,
      },
      tracking,
    );
    assert.equal(clean.kind, 'notified');
    assert.equal(clean.messageId, 'message-1');
    assert.equal(clean.headSha, 'head-7');
    assert.equal(deliveries.size, 1);

    const duplicate = await coordinator.recordCloud(
      {
        repoFullName: 'acme/widgets',
        prNumber: 7,
        headSha: 'head-7',
        status: 'clean',
        triggerCommentId: 70,
        reviewId: 71,
      },
      tracking,
    );
    assert.deepEqual(duplicate, { kind: 'state_only', reason: 'wake_already_delivered_for_head' });
    assert.equal(deliveries.size, 1);

    const staleRunningPoll = await coordinator.recordCloud(
      {
        repoFullName: 'acme/widgets',
        prNumber: 7,
        headSha: 'head-7',
        status: 'running',
        triggerCommentId: 70,
      },
      tracking,
    );
    assert.deepEqual(staleRunningPoll, { kind: 'state_only', reason: 'wake_already_delivered_for_head' });

    const projection = await objectStore.get('pr:acme/widgets#7');
    assert.equal(projection.externalReview.cloud.status, 'clean');
    assert.equal(projection.externalReview.wake.status, 'delivered');
    assert.equal(projection.externalReview.wake.messageId, 'message-1');
  });

  it('records cloud readiness but keeps delivery state-only for human-participant wake policy', async () => {
    configure();
    const humanOnlyTracking = { ...tracking, wakePolicy: 'human_participant_activity' };

    const ciResult = await coordinator.recordCi(ci(), humanOnlyTracking);
    assert.deepEqual(ciResult, { kind: 'state_only', reason: 'cloud_review_required' });

    const cloudResult = await coordinator.recordCloud(
      {
        repoFullName: 'acme/widgets',
        prNumber: 7,
        headSha: 'head-7',
        status: 'clean',
        triggerCommentId: 70,
        reviewId: 71,
      },
      humanOnlyTracking,
    );

    assert.deepEqual(cloudResult, { kind: 'state_only', reason: 'wake_policy_state_only' });
    assert.equal(deliveries.size, 0, 'actor-aware policy must fence the F168 delivery port');
    assert.ok(eventLog.events.some((event) => event.kind === 'case.cloud_review_observed'));
    assert.ok(eventLog.events.some((event) => event.kind === 'case.review_ready'));
    const projection = await objectStore.get('pr:acme/widgets#7');
    assert.equal(projection.externalReview.cloud.status, 'clean');
    assert.equal(projection.externalReview.wake.status, 'pending');
  });

  it('allows optional cloud not-requested readiness but never wakes observe-only repos', async () => {
    configure({ cloudReviewPolicy: 'optional' });
    const optional = await coordinator.recordCi(ci(), tracking);
    assert.equal(optional.kind, 'notified');
    assert.equal(deliveries.size, 1);

    configure({ reviewMode: 'observe_only', cloudReviewPolicy: 'optional', updatedAt: 2 });
    const observed = await coordinator.recordCi(ci({ headSha: 'head-8' }), tracking);
    assert.deepEqual(observed, { kind: 'state_only', reason: 'observe_only' });
    assert.equal(deliveries.size, 1);
  });

  it('does not regress a direct clean observation to running on a later empty poll', async () => {
    configure();
    await coordinator.recordCi(ci(), tracking);
    const clean = await coordinator.recordCloud(
      {
        repoFullName: 'acme/widgets',
        prNumber: 7,
        headSha: 'head-7',
        status: 'clean',
        triggerCommentId: 70,
        reviewId: 71,
      },
      tracking,
    );
    assert.equal(clean.kind, 'notified');

    await coordinator.recordCloud(
      {
        repoFullName: 'acme/widgets',
        prNumber: 7,
        headSha: 'head-7',
        status: 'running',
        triggerCommentId: 70,
      },
      tracking,
    );

    const projection = await objectStore.get('pr:acme/widgets#7');
    assert.equal(projection.externalReview.cloud.status, 'clean');
  });

  it('invalidates a prior wake when a new HEAD arrives', async () => {
    configure({ cloudReviewPolicy: 'optional' });
    const first = await coordinator.recordCi(ci(), tracking);
    assert.equal(first.kind, 'notified');

    const second = await coordinator.recordCi(ci({ headSha: 'head-8' }), tracking);
    assert.equal(second.kind, 'notified');
    assert.equal(second.headSha, 'head-8');
    assert.equal(deliveries.size, 2);
  });

  it('treats A -> B -> A as three review generations and wakes again for the reverted HEAD', async () => {
    configure({ cloudReviewPolicy: 'optional' });

    const first = await coordinator.recordCi(ci({ headSha: 'head-a' }), tracking);
    const second = await coordinator.recordCi(ci({ headSha: 'head-b' }), tracking);
    const reverted = await coordinator.recordCi(ci({ headSha: 'head-a' }), tracking);

    assert.equal(first.kind, 'notified');
    assert.equal(second.kind, 'notified');
    assert.equal(reverted.kind, 'notified');
    assert.equal(reverted.headSha, 'head-a');
    assert.equal(deliveries.size, 3);

    const headAEvents = eventLog.events.filter(
      (event) => event.kind === 'case.head_observed' && event.payload.headSha === 'head-a',
    );
    assert.equal(headAEvents.length, 2, 'the reverted SHA is a new lifecycle fact, not a duplicate event');
    assert.notEqual(headAEvents[0].sourceEventId, headAEvents[1].sourceEventId);

    const projection = await objectStore.get('pr:acme/widgets#7');
    assert.equal(projection.externalReview.currentHeadSha, 'head-a');
    assert.equal(projection.externalReview.headGeneration, 3);
    assert.equal(projection.externalReview.wake.status, 'delivered');
    assert.equal(projection.externalReview.wake.messageId, 'message-3');
  });

  it('repairs a projection when append succeeded but projector apply crashed before retry', async () => {
    configure({ cloudReviewPolicy: 'optional' });
    let failReviewReadyOnce = true;
    const flakyProjector = {
      async apply(event) {
        if (event.kind === 'case.review_ready' && failReviewReadyOnce) {
          failReviewReadyOnce = false;
          throw new Error('simulated append-before-projector crash');
        }
        await projector.apply(event);
      },
      async rebuild(subjectKey) {
        await projector.rebuild(subjectKey);
      },
    };
    const recoveringCoordinator = new ExternalReviewCoordinator({
      repoConfigStore: { getByRepo: async (repo) => configs.get(repo) ?? null },
      eventLog,
      projector: flakyProjector,
      objectStore,
      now: () => ++clock,
      deliverReady: async (input) => {
        const existing = deliveries.get(input.idempotencyKey);
        if (existing) return existing;
        const result = { messageId: `message-${deliveries.size + 1}`, content: input.content };
        deliveries.set(input.idempotencyKey, result);
        return result;
      },
      log: { info() {}, warn() {}, error() {} },
    });

    await assert.rejects(
      () => recoveringCoordinator.recordCi(ci(), tracking),
      /simulated append-before-projector crash/,
    );

    const retry = await recoveringCoordinator.recordCi(ci(), tracking);
    assert.equal(retry.kind, 'notified');
    assert.equal(retry.messageId, 'message-1');
    assert.equal(deliveries.size, 1);

    const projection = await objectStore.get('pr:acme/widgets#7');
    assert.equal(projection.externalReview.wake.status, 'delivered');
  });

  it('emits the noisy-wake tripwire when cloud state regresses during delivery', async () => {
    configure();
    let noisyWakeCount = 0;
    const racingCoordinator = new ExternalReviewCoordinator({
      repoConfigStore: { getByRepo: async (repo) => configs.get(repo) ?? null },
      eventLog,
      projector,
      objectStore,
      now: () => ++clock,
      recordNoisyWakeDuringCloudReview: () => {
        noisyWakeCount += 1;
      },
      deliverReady: async (input) => {
        const event = {
          sourceEventId: 'test:cloud-regressed-during-delivery',
          subjectKey: 'pr:acme/widgets#7',
          kind: 'case.cloud_review_observed',
          classification: 'informational',
          payload: { headSha: input.headSha, headGeneration: 1, status: 'running' },
          at: ++clock,
        };
        await eventLog.append(event);
        await projector.apply(event);
        return { messageId: 'message-racy', content: input.content };
      },
      log: { info() {}, warn() {}, error() {} },
    });

    await racingCoordinator.recordCi(ci(), tracking);
    const result = await racingCoordinator.recordCloud(
      {
        repoFullName: 'acme/widgets',
        prNumber: 7,
        headSha: 'head-7',
        status: 'clean',
        reviewId: 71,
      },
      tracking,
    );

    assert.equal(result.kind, 'notified');
    assert.equal(noisyWakeCount, 1);
  });

  it('emits the duplicate-wake tripwire and preserves the first canonical wake proof', async () => {
    configure({ cloudReviewPolicy: 'optional' });
    let duplicateWakeCount = 0;
    const racingCoordinator = new ExternalReviewCoordinator({
      repoConfigStore: { getByRepo: async (repo) => configs.get(repo) ?? null },
      eventLog,
      projector,
      objectStore,
      now: () => ++clock,
      recordDuplicateReviewerWake: () => {
        duplicateWakeCount += 1;
      },
      deliverReady: async (input) => {
        const event = {
          sourceEventId: 'test:first-concurrent-wake-proof',
          subjectKey: 'pr:acme/widgets#7',
          kind: 'case.reviewer_wake_delivered',
          classification: 'informational',
          payload: {
            headSha: input.headSha,
            headGeneration: 1,
            messageId: 'message-first',
          },
          at: ++clock,
        };
        await eventLog.append(event);
        await projector.apply(event);
        return { messageId: 'message-second', content: input.content };
      },
      log: { info() {}, warn() {}, error() {} },
    });

    const result = await racingCoordinator.recordCi(ci(), tracking);

    assert.deepEqual(result, { kind: 'state_only', reason: 'wake_already_delivered_for_head' });
    assert.equal(duplicateWakeCount, 1);
    const projection = await objectStore.get('pr:acme/widgets#7');
    assert.equal(projection.externalReview.wake.messageId, 'message-first');
  });

  it('does nothing when the repository has no F168 policy config', async () => {
    const result = await coordinator.recordCi(ci(), tracking);
    assert.deepEqual(result, { kind: 'not_tracked' });
    assert.equal(eventLog.events.length, 0);
    assert.equal(deliveries.size, 0);
  });
});
