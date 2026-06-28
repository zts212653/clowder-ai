/**
 * Validate Route endpoint tests (F168 Phase F — F2)
 *
 * POST /api/community-issues/:id/validate-route
 * Target cat accepts or rejects a routed issue.
 *
 * SO-2 state machine:
 *   pending → accepted  (target accepts)
 *   pending → rejected  (target rejects → clears assignment, state → pending-decision)
 *
 * INV-F2: routeAcceptance only changeable via /validate-route
 * INV-F3: rejected → clears assignedCatId + assignedThreadId
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('POST /api/community-issues/:id/validate-route', () => {
  let communityIssueStore;
  let app;

  const mockRegistry = {
    verify: async (invocationId, callbackToken) => {
      if (invocationId === 'inv-codex' && callbackToken === 'tok-codex') {
        return {
          ok: true,
          record: {
            invocationId: 'inv-codex',
            callbackToken: 'tok-codex',
            userId: 'user1',
            catId: 'codex',
            threadId: 'thread_guard',
            clientMessageIds: new Set(),
            createdAt: Date.now(),
          },
        };
      }
      if (invocationId === 'inv-opus' && callbackToken === 'tok-opus') {
        return {
          ok: true,
          record: {
            invocationId: 'inv-opus',
            callbackToken: 'tok-opus',
            userId: 'user1',
            catId: 'opus',
            threadId: 'thread_other',
            clientMessageIds: new Set(),
            createdAt: Date.now(),
          },
        };
      }
      return { ok: false, reason: 'unknown_invocation' };
    },
  };

  let issueId;

  function createObjectStore(seed = {}) {
    const projections = new Map(Object.entries(seed));
    return {
      get: async (subjectKey) => projections.get(subjectKey) ?? null,
      save: async (projection) => {
        projections.set(projection.subjectKey, projection);
      },
      listSubjectKeys: async () => [...projections.keys()],
      delete: async (subjectKey) => {
        projections.delete(subjectKey);
      },
    };
  }

  function routedProjection(subjectKey) {
    return {
      repo: 'zts212653/clowder-ai',
      type: 'issue',
      number: 42,
      subjectKey,
      state: 'routed',
      ownerThreadId: 'thread_guard',
      ownerRole: 'codex',
      nextOwner: 'cat',
      lastExternalActivityAt: null,
      lastPublicCommentAt: null,
      linkedIssues: [],
      linkedPrs: [],
      closureWaiver: null,
      appliedEventCount: 0,
      lastRejectedEvent: null,
      deliveryCursor: null,
      createdAt: 1,
      updatedAt: 1,
    };
  }

  beforeEach(async () => {
    const { createCommunityIssueStore } = await import(
      '../dist/domains/cats/services/stores/factories/CommunityIssueStoreFactory.js'
    );
    const { communityIssueRoutes } = await import('../dist/routes/community-issues.js');
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');

    communityIssueStore = createCommunityIssueStore();
    const taskStore = new TaskStore();

    app = Fastify();
    await app.register(communityIssueRoutes, {
      communityIssueStore,
      taskStore,
      socketManager: { broadcast: () => {} },
      registry: mockRegistry,
    });
    await app.ready();

    // Create a test issue in "accepted" state with route pending
    const created = await communityIssueStore.create({
      repo: 'zts212653/clowder-ai',
      issueNumber: 42,
      issueType: 'feature',
      title: 'Test issue for validate-route',
    });
    issueId = created.id;

    // Set up the issue as routed with pending acceptance
    await communityIssueStore.update(issueId, {
      state: 'accepted',
      assignedCatId: 'codex',
      assignedThreadId: 'thread_guard',
      lastActivity: { at: Date.now(), event: 'routed' },
    });
  });

  it('accepts route — routeAcceptance pending → accepted', async () => {
    // Set routeAcceptance to pending
    await communityIssueStore.update(issueId, {
      routeAcceptance: 'pending',
      routeSource: 'auto',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${issueId}/validate-route`,
      headers: {
        'x-invocation-id': 'inv-codex',
        'x-callback-token': 'tok-codex',
      },
      payload: { decision: 'accept' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.routeAcceptance, 'accepted');

    // Verify persisted state
    const issue = await communityIssueStore.get(issueId);
    assert.equal(issue.routeAcceptance, 'accepted');
    assert.equal(issue.assignedCatId, 'codex');
  });

  it('rejects route — routeAcceptance pending → rejected, clears assignment', async () => {
    await communityIssueStore.update(issueId, {
      routeAcceptance: 'pending',
      routeSource: 'auto',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${issueId}/validate-route`,
      headers: {
        'x-invocation-id': 'inv-codex',
        'x-callback-token': 'tok-codex',
      },
      payload: { decision: 'reject', reason: 'Not my area' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.routeAcceptance, 'rejected');

    // INV-F3: assignment cleared
    const issue = await communityIssueStore.get(issueId);
    assert.equal(issue.routeAcceptance, 'rejected');
    assert.equal(issue.assignedCatId, null);
    assert.equal(issue.assignedThreadId, null);
    assert.equal(issue.state, 'pending-decision');
  });

  it('returns 409 when routeAcceptance is not pending', async () => {
    // routeAcceptance is null (not pending)
    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${issueId}/validate-route`,
      headers: {
        'x-invocation-id': 'inv-codex',
        'x-callback-token': 'tok-codex',
      },
      payload: { decision: 'accept' },
    });

    assert.equal(res.statusCode, 409);
  });

  it('returns 403 when caller is not the assigned cat', async () => {
    await communityIssueStore.update(issueId, {
      routeAcceptance: 'pending',
      routeSource: 'auto',
    });

    // opus tries to validate a route assigned to codex
    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${issueId}/validate-route`,
      headers: {
        'x-invocation-id': 'inv-opus',
        'x-callback-token': 'tok-opus',
      },
      payload: { decision: 'accept' },
    });

    assert.equal(res.statusCode, 403);
  });

  it('rejection deletes tracking task registered by auto-route (P1-R3-2)', async () => {
    // Set up issue as auto-routed with pending acceptance
    await communityIssueStore.update(issueId, {
      routeAcceptance: 'pending',
      routeSource: 'auto',
    });

    // Simulate a tracking task registered by auto-route
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const taskStore = new TaskStore();
    const subjectKey = `issue:zts212653/clowder-ai#42`;
    await taskStore.upsertBySubject({
      kind: 'issue_tracking',
      subjectKey,
      threadId: 'thread_guard',
      title: 'Issue tracking: zts212653/clowder-ai#42',
      why: 'Auto-registered on case.routed',
      createdBy: 'system',
    });

    // Verify task exists before rejection
    const taskBefore = await taskStore.getBySubject(subjectKey);
    assert.ok(taskBefore, 'tracking task should exist before rejection');

    // Rebuild app with taskStore wired
    const { communityIssueRoutes } = await import('../dist/routes/community-issues.js');
    const appWithTasks = Fastify();
    await appWithTasks.register(communityIssueRoutes, {
      communityIssueStore,
      taskStore,
      socketManager: { broadcast: () => {} },
      registry: mockRegistry,
    });
    await appWithTasks.ready();

    // Reject the route
    const res = await appWithTasks.inject({
      method: 'POST',
      url: `/api/community-issues/${issueId}/validate-route`,
      headers: {
        'x-invocation-id': 'inv-codex',
        'x-callback-token': 'tok-codex',
      },
      payload: { decision: 'reject', reason: 'Not my area' },
    });
    assert.equal(res.statusCode, 200);

    // P1-R3-2: tracking task should be deleted after rejection
    const taskAfter = await taskStore.getBySubject(subjectKey);
    assert.equal(taskAfter, null, 'tracking task must be deleted on route rejection');
  });

  it('applies route_rejected to the projection so rejected routed cases re-enter the decision queue', async () => {
    await communityIssueStore.update(issueId, {
      routeAcceptance: 'pending',
      routeSource: 'auto',
    });

    const subjectKey = 'issue:zts212653/clowder-ai#42';
    const objectStore = createObjectStore({ [subjectKey]: routedProjection(subjectKey) });
    const { CommunityProjector } = await import('../dist/domains/community/community-projector.js');
    const projector = new CommunityProjector(
      { listSubjects: async () => [], listBySubject: async () => [] },
      objectStore,
    );
    const eventLog = { append: async () => ({ appended: true }) };
    const { communityIssueRoutes } = await import('../dist/routes/community-issues.js');
    const appWithProjector = Fastify();
    await appWithProjector.register(communityIssueRoutes, {
      communityIssueStore,
      taskStore: { getBySubject: async () => null, delete: async () => {} },
      socketManager: { broadcast: () => {} },
      registry: mockRegistry,
      eventLog,
      projector,
      objectStore,
    });
    await appWithProjector.ready();

    const res = await appWithProjector.inject({
      method: 'POST',
      url: `/api/community-issues/${issueId}/validate-route`,
      headers: {
        'x-invocation-id': 'inv-codex',
        'x-callback-token': 'tok-codex',
      },
      payload: { decision: 'reject', reason: 'Not my area' },
    });

    assert.equal(res.statusCode, 200);
    const projection = await objectStore.get(subjectKey);
    assert.equal(projection.state, 'triaged');
    assert.equal(projection.appliedEventCount, 1);
  });

  it('returns 404 for non-existent issue', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/nonexistent/validate-route',
      headers: {
        'x-invocation-id': 'inv-codex',
        'x-callback-token': 'tok-codex',
      },
      payload: { decision: 'accept' },
    });

    assert.equal(res.statusCode, 404);
  });
});
