import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

describe('Community decision queue routes (F168 Phase E E-PR1)', () => {
  let communityIssueStore;
  let taskStore;
  let communityPrStore;

  beforeEach(async () => {
    const { createCommunityIssueStore } = await import(
      '../dist/domains/cats/services/stores/factories/CommunityIssueStoreFactory.js'
    );
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const { InMemoryCommunityPrStore } = await import(
      '../dist/domains/cats/services/stores/memory/InMemoryCommunityPrStore.js'
    );
    communityIssueStore = createCommunityIssueStore();
    taskStore = new TaskStore();
    communityPrStore = new InMemoryCommunityPrStore();
  });

  async function createApp(opts = {}) {
    const { communityIssueRoutes } = await import('../dist/routes/community-issues.js');
    const app = Fastify();
    await app.register(communityIssueRoutes, {
      communityIssueStore,
      taskStore,
      communityPrStore,
      socketManager: { broadcastToRoom() {} },
      ...opts,
    });
    return app;
  }

  function createFindingStore(initialFindings = []) {
    const map = new Map(initialFindings.map((finding) => [finding.findingId, { ...finding }]));
    return {
      async listAll() {
        return [...map.values()];
      },
      async get(findingId) {
        return map.get(findingId) ?? null;
      },
      async acknowledge(findingId) {
        const current = map.get(findingId);
        if (current) map.set(findingId, { ...current, status: 'acknowledged', updatedAt: Date.now() });
      },
      async resolve(findingId) {
        const current = map.get(findingId);
        if (current) map.set(findingId, { ...current, status: 'resolved', updatedAt: Date.now() });
      },
      async waive(findingId, waiver) {
        const current = map.get(findingId);
        if (current) map.set(findingId, { ...current, status: 'waived', waiver, updatedAt: Date.now() });
      },
    };
  }

  function createObjectStore(projections = {}) {
    return {
      async get(subjectKey) {
        return projections[subjectKey] ?? null;
      },
      async listSubjectKeys() {
        return Object.keys(projections);
      },
    };
  }

  function finding(overrides = {}) {
    return {
      findingId: 'finding-open',
      subjectKey: 'issue:acme/repo#42',
      findingKind: 'stale-awaiting-external',
      severity: 'warning',
      message: 'Awaiting external for 15d.',
      status: 'open',
      waiver: null,
      evidenceFingerprint: 'fingerprint-1',
      createdAt: 1_000,
      updatedAt: 2_000,
      ...overrides,
    };
  }

  test('GET /api/community-decision-queue requires repo', async () => {
    const app = await createApp();
    const res = await app.inject({ method: 'GET', url: '/api/community-decision-queue' });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /repo/i);
  });

  test('GET /api/community-decision-queue returns projection/direction items without findingStore', async () => {
    const app = await createApp();
    const issue = await communityIssueStore.create({
      repo: 'acme/repo',
      issueNumber: 42,
      issueType: 'feature',
      title: 'Needs direction',
    });
    await communityIssueStore.update(issue.id, {
      state: 'pending-decision',
      directionCard: {
        entries: [
          {
            authoredByRole: 'narrator',
            routeRecommendation: { kind: 'new-thread' },
            narrative: 'Needs a new thread.',
            timestamp: 2_000,
          },
        ],
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/community-decision-queue?repo=acme/repo',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.repo, 'acme/repo');
    assert.ok(body.warnings.some((warning) => /findingStore/i.test(warning)));
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].kind, 'direction-decision');
  });

  test('GET /api/community-decision-queue includes finding-derived items', async () => {
    const app = await createApp({
      findingStore: createFindingStore([finding()]),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/community-decision-queue?repo=acme/repo',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].kind, 'external-followup');
    assert.equal(body.items[0].priority, 'normal');
  });

  test('GET /api/community-decision-queue does not emit dead closure actions for projection-only issues', async () => {
    const app = await createApp({
      objectStore: createObjectStore({
        'issue:acme/repo#42': {
          subjectKey: 'issue:acme/repo#42',
          number: 42,
          state: 'fixed',
          ownerThreadId: 'thread-1',
          ownerRole: 'case-owner',
          updatedAt: 2_000,
          closureWaiver: null,
        },
      }),
      findingStore: createFindingStore([]),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/community-decision-queue?repo=acme/repo',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(
      body.items.some((item) => item.kind === 'closure-action'),
      false,
    );
  });

  test('GET /api/community-decision-queue uses projection timestamp for enriched closure actions', async () => {
    const projectionUpdatedAt = Date.now() + 60_000;
    const issue = await communityIssueStore.create({
      repo: 'acme/repo',
      issueNumber: 43,
      issueType: 'feature',
      title: 'Already fixed upstream',
    });
    await communityIssueStore.update(issue.id, {
      updatedAt: 1_000,
    });
    const app = await createApp({
      objectStore: createObjectStore({
        'issue:acme/repo#43': {
          subjectKey: 'issue:acme/repo#43',
          number: 43,
          state: 'fixed',
          ownerThreadId: 'thread-1',
          ownerRole: 'case-owner',
          updatedAt: projectionUpdatedAt,
          lastPublicCommentAt: null,
          closureWaiver: null,
        },
      }),
      findingStore: createFindingStore([]),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/community-decision-queue?repo=acme/repo',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    const item = body.items.find((queueItem) => queueItem.kind === 'closure-action');
    assert.ok(item);
    assert.equal(item.lastUpdatedAt, projectionUpdatedAt);
    assert.equal(item.source.assignedThreadId, 'thread-1');
    assert.deepEqual(
      item.recommendedActions.map((action) => action.kind),
      ['open-thread', 'mark-reported', 'waive-closure'],
    );
    assert.equal(item.recommendedActions[0].threadId, 'thread-1');
  });
});
