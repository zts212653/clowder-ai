import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CommunityProjector } from '../dist/domains/community/community-projector.js';

class MemoryEventLog {
  events = [];

  async append(event) {
    if (this.events.some((candidate) => candidate.sourceEventId === event.sourceEventId)) {
      return { appended: false, sequence: -1 };
    }
    this.events.push(event);
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
const makeEvent = (sourceEventId, kind, payload, at) => ({
  sourceEventId,
  subjectKey,
  kind,
  classification: 'informational',
  payload,
  at,
});

describe('F168 external review projector integration', () => {
  it('rebuilds the same external-review aggregate without treating lifecycle facts as rejected events', async () => {
    const eventLog = new MemoryEventLog();
    const objectStore = new MemoryObjectStore();
    const projector = new CommunityProjector(eventLog, objectStore);
    const events = [
      makeEvent(
        'assign',
        'case.external_review_assigned',
        {
          mode: 'maintainer_review',
          cloudPolicy: 'required',
          reviewerCatId: 'codex-sol',
          reviewerThreadId: 'thread-f168',
        },
        1_000,
      ),
      makeEvent('head-1', 'case.head_observed', { headSha: 'abc123' }, 1_100),
      makeEvent('ci-1', 'case.ci_observed', { headSha: 'abc123', status: 'pass' }, 1_200),
      makeEvent('cloud-1', 'case.cloud_review_observed', { headSha: 'abc123', status: 'clean', reviewId: 91 }, 1_300),
      makeEvent('ready-1', 'case.review_ready', { headSha: 'abc123' }, 1_400),
    ];

    for (const event of events) {
      await eventLog.append(event);
      await projector.apply(event);
    }

    const incremental = await objectStore.get(subjectKey);
    assert.ok(incremental.externalReview);
    assert.equal(incremental.externalReview.lifecycle, 'rereview_required');
    assert.equal(incremental.externalReview.currentHeadSha, 'abc123');
    assert.equal(incremental.externalReview.currentHeadObservedAt, 1_100);
    assert.equal(incremental.externalReview.wake.status, 'pending');
    assert.equal(incremental.lastRejectedEvent, null);
    assert.equal(incremental.appliedEventCount, events.length);

    await projector.rebuild(subjectKey);
    const rebuilt = await objectStore.get(subjectKey);

    assert.deepEqual(rebuilt.externalReview, incremental.externalReview);
    assert.equal(rebuilt.lastRejectedEvent, null);
    assert.equal(rebuilt.appliedEventCount, events.length);
  });

  it('keeps a stale current-head fact in the log without corrupting the live aggregate', async () => {
    const eventLog = new MemoryEventLog();
    const objectStore = new MemoryObjectStore();
    const projector = new CommunityProjector(eventLog, objectStore);
    const events = [
      makeEvent(
        'assign',
        'case.external_review_assigned',
        {
          mode: 'maintainer_review',
          cloudPolicy: 'optional',
          reviewerCatId: 'codex-sol',
          reviewerThreadId: 'thread-f168',
        },
        1_000,
      ),
      makeEvent('head-current', 'case.head_observed', { headSha: 'current' }, 1_100),
      makeEvent('ci-stale', 'case.ci_observed', { headSha: 'old', status: 'pass' }, 1_200),
    ];

    for (const event of events) {
      await eventLog.append(event);
      await projector.apply(event);
    }

    const projection = await objectStore.get(subjectKey);
    assert.equal(projection.externalReview.currentHeadSha, 'current');
    assert.equal(projection.externalReview.ci, null);
    assert.equal(projection.lastRejectedEvent, null);
    assert.equal(projection.appliedEventCount, 2);
    assert.equal((await eventLog.read(subjectKey)).length, 3);
  });

  it('invalidates pending reviewer intent when assignment custody changes on the same HEAD', async () => {
    const eventLog = new MemoryEventLog();
    const objectStore = new MemoryObjectStore();
    const projector = new CommunityProjector(eventLog, objectStore);
    const events = [
      makeEvent(
        'assign-original',
        'case.external_review_assigned',
        {
          mode: 'maintainer_review',
          cloudPolicy: 'optional',
          reviewerCatId: 'codex-sol',
          reviewerThreadId: 'thread-f168',
          actionLeaseRef: { leaseId: 'lease-1', generation: 1 },
        },
        1_000,
      ),
      makeEvent('head-pending', 'case.head_observed', { headSha: 'abc123', headGeneration: 1 }, 1_100),
      makeEvent('ci-pending', 'case.ci_observed', { headSha: 'abc123', headGeneration: 1, status: 'pending' }, 1_200),
      makeEvent(
        'verdict-pending',
        'case.review_verdict_submitted',
        {
          fingerprint: 'verdict-original-reviewer',
          headSha: 'abc123',
          headGeneration: 1,
          verdict: 'approved',
          summary: 'Original reviewer intent.',
          userNudgeRequired: false,
          delivery: {
            kind: 'delivered',
            headSha: 'abc123',
            githubUrl: 'https://github.com/acme/widgets/pull/7#pullrequestreview-42',
            deliveredAt: 1_300,
          },
          principal: { catId: 'codex-sol', threadId: 'thread-f168' },
          actionLeaseRef: { leaseId: 'lease-1', generation: 1 },
          verificationReason: 'ci_pending',
        },
        1_300,
      ),
      makeEvent(
        'assign-replacement',
        'case.external_review_assigned',
        {
          mode: 'maintainer_review',
          cloudPolicy: 'optional',
          reviewerCatId: 'opus5',
          reviewerThreadId: 'thread-replacement',
          actionLeaseRef: { leaseId: 'lease-2', generation: 2 },
        },
        1_400,
      ),
    ];

    for (const currentEvent of events) {
      await eventLog.append(currentEvent);
      await projector.apply(currentEvent);
    }

    const projection = await objectStore.get(subjectKey);
    assert.equal(projection.externalReview.reviewerCatId, 'opus5');
    assert.deepEqual(projection.externalReview.actionLeaseRef, { leaseId: 'lease-2', generation: 2 });
    assert.equal(projection.externalReview.pendingVerdict, null);
    assert.equal(
      projection.externalReview.verdictSubmissionEpoch,
      1,
      'a replacement custody must advance the durable submission epoch',
    );

    const duplicateReplacement = makeEvent(
      'assign-replacement-duplicate',
      'case.external_review_assigned',
      {
        mode: 'maintainer_review',
        cloudPolicy: 'optional',
        reviewerCatId: 'opus5',
        reviewerThreadId: 'thread-replacement',
        actionLeaseRef: { leaseId: 'lease-2', generation: 2 },
      },
      1_500,
    );
    await eventLog.append(duplicateReplacement);
    await projector.apply(duplicateReplacement);
    assert.equal(
      (await objectStore.get(subjectKey)).externalReview.verdictSubmissionEpoch,
      1,
      'an identical custody observation must not advance the epoch again',
    );
  });

  it('projects PR terminal facts into both generic state and the external-review aggregate', async () => {
    for (const [kind, expectedState] of [
      ['pr.merged', 'fixed'],
      ['pr.closed', 'closed'],
      ['case.declined', 'declined'],
    ]) {
      const eventLog = new MemoryEventLog();
      const objectStore = new MemoryObjectStore();
      const projector = new CommunityProjector(eventLog, objectStore);
      const events = [
        makeEvent(
          `assign-${kind}`,
          'case.external_review_assigned',
          {
            mode: 'maintainer_review',
            cloudPolicy: 'optional',
            reviewerCatId: 'codex-sol',
            reviewerThreadId: 'thread-f168',
          },
          1_000,
        ),
        makeEvent(`head-${kind}`, 'case.head_observed', { headSha: 'abc123', headGeneration: 1 }, 1_100),
        { ...makeEvent(`terminal-${kind}`, kind, {}, 1_200), classification: 'state-changing' },
      ];

      for (const event of events) {
        await eventLog.append(event);
        await projector.apply(event);
      }

      const projection = await objectStore.get(subjectKey);
      assert.equal(projection.state, expectedState);
      assert.equal(projection.externalReview.lifecycle, 'terminal');

      await projector.rebuild(subjectKey);
      const rebuilt = await objectStore.get(subjectKey);
      assert.equal(rebuilt.state, expectedState);
      assert.equal(rebuilt.externalReview.lifecycle, 'terminal');
    }
  });
});
