/**
 * Board aggregation projection enrichment tests (F168 Phase A — Task 9)
 *
 * Verifies:
 * 1. Without objectStore: board response shape is exactly backward-compatible
 * 2. With objectStore: board response includes new projection fields
 *    (projectionState, nextOwner, closureWaiver) without breaking old fields
 * 3. Issues without projections return without extra fields (no crash)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ---------------------------------------------------------------------------
// In-memory objectStore stub
// ---------------------------------------------------------------------------

function makeObjectStore(projections = []) {
  const map = new Map(projections.map((p) => [p.subjectKey, p]));
  return {
    get: async (subjectKey) => map.get(subjectKey) ?? null,
    save: async (p) => {
      map.set(p.subjectKey, p);
    },
    listSubjectKeys: async () => [...map.keys()],
    delete: async (k) => {
      map.delete(k);
    },
  };
}

function makeFakeIssueStore() {
  const issues = [
    {
      id: 'issue-1',
      repo: 'owner/repo',
      issueNumber: 42,
      issueType: 'bug',
      title: 'Test bug',
      state: 'unreplied',
      replyState: 'unreplied',
      assignedThreadId: null,
      assignedCatId: null,
      linkedPrNumbers: [],
      directionCard: null,
      ownerDecision: null,
      relatedFeature: null,
      guardianAssignment: null,
      lastActivity: { at: 1000, event: 'created' },
      createdAt: 1000,
      updatedAt: 1000,
    },
  ];
  return {
    listByRepo: async (repo) => issues.filter((i) => i.repo === repo),
    get: async () => null,
    create: async () => null,
    update: async () => null,
    listAll: async () => [],
    getByRepoAndNumber: async () => null,
    delete: async () => null,
  };
}

async function buildApp(extraOpts = {}) {
  const [appMod, fastifyMod] = await Promise.all([import('../dist/routes/community-issues.js'), import('fastify')]);
  const fastify = fastifyMod.default({ logger: false });
  fastify.register(appMod.communityIssueRoutes, {
    communityIssueStore: makeFakeIssueStore(),
    taskStore: {
      listByKind: async (kind) => {
        if (kind === 'pr_tracking') return [];
        return [];
      },
    },
    socketManager: { emit: () => {} },
    ...extraOpts,
  });
  return fastify;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Task 9 — board aggregation projection enrichment', () => {
  it('without objectStore: board response is backward-compatible', async () => {
    const app = await buildApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/community-board?repo=owner/repo',
    });

    assert.strictEqual(res.statusCode, 200, 'board should succeed');
    const body = res.json();

    assert.strictEqual(body.repo, 'owner/repo', 'repo field must be present');
    assert.ok(Array.isArray(body.issues), 'issues must be an array');
    assert.ok(Array.isArray(body.prItems), 'prItems must be an array');

    // Backward compat: original fields present
    if (body.issues.length > 0) {
      const issue = body.issues[0];
      assert.ok('state' in issue, 'state field must be present');
      assert.ok('issueNumber' in issue, 'issueNumber field must be present');
      // No projection fields without objectStore
      assert.ok(!('projectionState' in issue), 'projectionState should NOT be present without objectStore');
    }

    await app.close();
  });

  it('with objectStore: board issues include projection fields', async () => {
    const projection = {
      repo: 'owner/repo',
      type: 'issue',
      number: 42,
      subjectKey: 'issue:owner/repo#42',
      state: 'triaged',
      ownerThreadId: 'thread-1',
      ownerRole: 'codex',
      nextOwner: 'owner',
      lastExternalActivityAt: null,
      lastPublicCommentAt: null,
      linkedIssues: [],
      linkedPrs: [],
      closureWaiver: null,
      appliedEventCount: 2,
      lastRejectedEvent: null,
      deliveryCursor: null,
      createdAt: 1000,
      updatedAt: 2000,
    };

    const objectStore = makeObjectStore([projection]);
    const app = await buildApp({ objectStore });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/community-board?repo=owner/repo',
    });

    assert.strictEqual(res.statusCode, 200);
    const body = res.json();

    assert.ok(Array.isArray(body.issues));
    const issue = body.issues.find((i) => i.issueNumber === 42);
    assert.ok(issue, 'issue 42 must be present');

    // Old fields preserved
    assert.ok('state' in issue, 'old state field preserved');
    assert.strictEqual(issue.issueNumber, 42, 'issueNumber preserved');
    assert.strictEqual(issue.issueType, 'bug', 'issueType preserved');

    // New projection fields added
    assert.strictEqual(issue.projectionState, 'triaged', 'projectionState must be set from projection');
    assert.strictEqual(issue.nextOwner, 'owner', 'nextOwner must be set from projection');
    assert.strictEqual(issue.closureWaiver, null, 'closureWaiver must be set from projection');

    await app.close();
  });

  it('P1-2: projection-only case (webhook, not in legacy store) appears on board', async () => {
    // This issue came via GitHub webhook → exists in objectStore but NOT in communityIssueStore
    const webhookProjection = {
      repo: 'owner/repo',
      type: 'issue',
      number: 999,
      subjectKey: 'issue:owner/repo#999',
      state: 'new',
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
      createdAt: 3000,
      updatedAt: 3000,
    };
    const objectStore = makeObjectStore([webhookProjection]);
    const app = await buildApp({ objectStore });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/community-board?repo=owner/repo',
    });

    assert.strictEqual(res.statusCode, 200);
    const body = res.json();

    // Issue #999 must appear — it only exists in projection (came via webhook)
    const webhookIssue = body.issues.find((i) => i.issueNumber === 999);
    assert.ok(webhookIssue, 'projection-only issue #999 must appear on board');
    assert.strictEqual(webhookIssue.projectionState, 'new', 'projectionState should be set from projection');

    await app.close();
  });

  it('projection-only PR (webhook, not in legacy store) appears in prItems', async () => {
    const prProjection = {
      repo: 'owner/repo',
      type: 'pr',
      number: 88,
      subjectKey: 'pr:owner/repo#88',
      state: 'new',
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
      createdAt: 1000,
      updatedAt: 2000,
    };

    const objectStore = makeObjectStore([prProjection]);
    const app = await buildApp({ objectStore });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/community-board?repo=owner/repo',
    });

    assert.strictEqual(res.statusCode, 200);
    const body = res.json();

    assert.ok(Array.isArray(body.prItems), 'prItems must be array');
    const prItem = body.prItems.find((p) => p.prNumber === 88);
    assert.ok(prItem, 'projection-only PR #88 must appear in prItems');
    assert.strictEqual(prItem.projectionState, 'new', 'projectionState must be set from projection');

    await app.close();
  });

  it('projection-only closed issue appears with state:closed, not unreplied', async () => {
    // Projection-only issue (webhook-only, not in legacy store) that has been closed
    const closedProjection = {
      repo: 'owner/repo',
      type: 'issue',
      number: 777,
      subjectKey: 'issue:owner/repo#777',
      state: 'closed',
      ownerThreadId: null,
      ownerRole: null,
      nextOwner: 'none',
      lastExternalActivityAt: null,
      lastPublicCommentAt: null,
      linkedIssues: [],
      linkedPrs: [],
      closureWaiver: null,
      appliedEventCount: 2,
      lastRejectedEvent: null,
      deliveryCursor: null,
      createdAt: 1000,
      updatedAt: 5000,
    };
    const objectStore = makeObjectStore([closedProjection]);
    const app = await buildApp({ objectStore });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/community-board?repo=owner/repo' });
    assert.strictEqual(res.statusCode, 200);
    const body = res.json();

    const closedIssue = body.issues.find((i) => i.issueNumber === 777);
    assert.ok(closedIssue, 'projection-only closed issue #777 must appear on board');
    assert.strictEqual(
      closedIssue.state,
      'closed',
      `projection-only closed issue must have state 'closed', got '${closedIssue.state}'`,
    );
    assert.strictEqual(closedIssue.projectionState, 'closed', 'projectionState must be closed');

    await app.close();
  });

  it('projection-only fixed issue (pr merged cascade) appears with state:closed', async () => {
    // Issue that was fixed via PR merge (projectionState = 'fixed')
    const fixedProjection = {
      repo: 'owner/repo',
      type: 'issue',
      number: 888,
      subjectKey: 'issue:owner/repo#888',
      state: 'fixed',
      ownerThreadId: null,
      ownerRole: null,
      nextOwner: 'none',
      lastExternalActivityAt: null,
      lastPublicCommentAt: null,
      linkedIssues: [],
      linkedPrs: [10],
      closureWaiver: null,
      appliedEventCount: 2,
      lastRejectedEvent: null,
      deliveryCursor: null,
      createdAt: 1000,
      updatedAt: 6000,
    };
    const objectStore = makeObjectStore([fixedProjection]);
    const app = await buildApp({ objectStore });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/community-board?repo=owner/repo' });
    assert.strictEqual(res.statusCode, 200);
    const body = res.json();

    const fixedIssue = body.issues.find((i) => i.issueNumber === 888);
    assert.ok(fixedIssue, 'projection-only fixed issue #888 must appear on board');
    assert.strictEqual(
      fixedIssue.state,
      'closed',
      `projection-only fixed issue must have state 'closed', got '${fixedIssue.state}'`,
    );
    assert.strictEqual(fixedIssue.projectionState, 'fixed', 'projectionState must be fixed');

    await app.close();
  });

  it('with objectStore but no matching projection: issue returned as-is (no crash)', async () => {
    const objectStore = makeObjectStore([]); // empty — no projections
    const app = await buildApp({ objectStore });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/community-board?repo=owner/repo',
    });

    assert.strictEqual(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.issues), 'issues array present');
    // Issue present but no projectionState (no projection in store)
    if (body.issues.length > 0) {
      assert.ok(!('projectionState' in body.issues[0]), 'projectionState not present when no projection');
    }

    await app.close();
  });
});
