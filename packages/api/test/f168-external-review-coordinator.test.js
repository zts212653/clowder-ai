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
  let coordinator;
  let clock;

  beforeEach(() => {
    eventLog = new MemoryEventLog();
    objectStore = new MemoryObjectStore();
    projector = new CommunityProjector(eventLog, objectStore);
    configs = new Map();
    clock = 1_000;
    coordinator = new ExternalReviewCoordinator({
      repoConfigStore: { getByRepo: async (repo) => configs.get(repo) ?? null },
      eventLog,
      projector,
      objectStore,
      now: () => ++clock,
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

  it('continues collection only for configured non-terminal maintainer-review cases', async () => {
    assert.equal(await coordinator.shouldContinueTracking('acme/widgets', 7), false);

    configure({ reviewMode: 'observe_only' });
    assert.equal(await coordinator.shouldContinueTracking('acme/widgets', 7), false);

    configure();
    assert.equal(await coordinator.shouldContinueTracking('acme/widgets', 7), true);

    await objectStore.save({
      subjectKey: 'pr:acme/widgets#7',
      externalReview: { lifecycle: 'terminal' },
    });
    assert.equal(await coordinator.shouldContinueTracking('acme/widgets', 7), false);
  });

  it('records required-cloud readiness but never projects it into a connector wake', async () => {
    configure();

    assert.deepEqual(await coordinator.recordCi(ci(), tracking), {
      kind: 'state_only',
      reason: 'cloud_review_required',
    });
    assert.deepEqual(
      await coordinator.recordCloud(
        {
          repoFullName: 'acme/widgets',
          prNumber: 7,
          headSha: 'head-7',
          status: 'running',
          triggerCommentId: 70,
        },
        tracking,
      ),
      { kind: 'state_only', reason: 'cloud_review_running' },
    );
    assert.deepEqual(
      await coordinator.recordCloud(
        {
          repoFullName: 'acme/widgets',
          prNumber: 7,
          headSha: 'head-7',
          status: 'clean',
          triggerCommentId: 70,
          reviewId: 71,
        },
        tracking,
      ),
      { kind: 'state_only', reason: 'explicit_wait_required' },
    );

    assert.ok(eventLog.events.some((event) => event.kind === 'case.review_ready'));
    const projection = await objectStore.get('pr:acme/widgets#7');
    assert.equal(projection.externalReview.cloud.status, 'clean');
    assert.equal(projection.externalReview.wake.status, 'pending');
  });

  it('keeps optional-cloud and observe-only repositories state-only', async () => {
    configure({ cloudReviewPolicy: 'optional' });
    assert.deepEqual(await coordinator.recordCi(ci(), tracking), {
      kind: 'state_only',
      reason: 'explicit_wait_required',
    });

    configure({ reviewMode: 'observe_only', cloudReviewPolicy: 'optional', updatedAt: 2 });
    assert.deepEqual(await coordinator.recordCi(ci({ headSha: 'head-8' }), tracking), {
      kind: 'state_only',
      reason: 'observe_only',
    });
  });

  it('does not regress a direct clean observation to running on a later empty poll', async () => {
    configure();
    await coordinator.recordCi(ci(), tracking);
    await coordinator.recordCloud(
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
    assert.deepEqual(
      await coordinator.recordCloud(
        {
          repoFullName: 'acme/widgets',
          prNumber: 7,
          headSha: 'head-7',
          status: 'running',
          triggerCommentId: 70,
        },
        tracking,
      ),
      { kind: 'state_only', reason: 'explicit_wait_required' },
    );

    const projection = await objectStore.get('pr:acme/widgets#7');
    assert.equal(projection.externalReview.cloud.status, 'clean');
  });

  it('treats A -> B -> A as three durable review generations without waking', async () => {
    configure({ cloudReviewPolicy: 'optional' });

    const first = await coordinator.recordCi(ci({ headSha: 'head-a' }), tracking);
    const second = await coordinator.recordCi(ci({ headSha: 'head-b' }), tracking);
    const reverted = await coordinator.recordCi(ci({ headSha: 'head-a' }), tracking);

    assert.equal(first.reason, 'explicit_wait_required');
    assert.equal(second.reason, 'explicit_wait_required');
    assert.equal(reverted.reason, 'explicit_wait_required');

    const headAEvents = eventLog.events.filter(
      (event) => event.kind === 'case.head_observed' && event.payload.headSha === 'head-a',
    );
    assert.equal(headAEvents.length, 2);
    assert.notEqual(headAEvents[0].sourceEventId, headAEvents[1].sourceEventId);

    const projection = await objectStore.get('pr:acme/widgets#7');
    assert.equal(projection.externalReview.currentHeadSha, 'head-a');
    assert.equal(projection.externalReview.headGeneration, 3);
    assert.equal(projection.externalReview.wake.status, 'pending');
  });

  it('repairs projection after append succeeded but projector apply crashed', async () => {
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
      log: { info() {}, warn() {}, error() {} },
    });

    await assert.rejects(
      () => recoveringCoordinator.recordCi(ci(), tracking),
      /simulated append-before-projector crash/,
    );
    assert.deepEqual(await recoveringCoordinator.recordCi(ci(), tracking), {
      kind: 'state_only',
      reason: 'explicit_wait_required',
    });

    const projection = await objectStore.get('pr:acme/widgets#7');
    assert.equal(projection.externalReview.wake.status, 'pending');
  });

  it('does nothing when the repository has no F168 policy config', async () => {
    assert.deepEqual(await coordinator.recordCi(ci(), tracking), { kind: 'not_tracked' });
    assert.equal(eventLog.events.length, 0);
  });
});
