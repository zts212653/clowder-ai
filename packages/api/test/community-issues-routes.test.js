import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

describe('Community Issues Routes', () => {
  let communityIssueStore;
  let taskStore;

  beforeEach(async () => {
    const { createCommunityIssueStore } = await import(
      '../dist/domains/cats/services/stores/factories/CommunityIssueStoreFactory.js'
    );
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    communityIssueStore = createCommunityIssueStore();
    taskStore = new TaskStore();
  });

  const mockThreadStore = {
    create: async (_userId, title) => ({ id: `thread_${Date.now()}`, title, createdAt: Date.now() }),
  };

  async function createApp() {
    const { communityIssueRoutes } = await import('../dist/routes/community-issues.js');
    const app = Fastify();
    const socketManager = { broadcastToRoom() {} };
    await app.register(communityIssueRoutes, {
      communityIssueStore,
      taskStore,
      socketManager,
      threadStore: mockThreadStore,
    });
    return app;
  }

  test('POST /api/community-issues creates item', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues',
      payload: {
        repo: 'zts212653/clowder-ai',
        issueNumber: 42,
        issueType: 'feature',
        title: 'Support dark mode',
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.repo, 'zts212653/clowder-ai');
    assert.equal(body.issueNumber, 42);
    assert.equal(body.state, 'unreplied');
  });

  test('POST /api/community-issues rejects duplicate', async () => {
    const app = await createApp();
    await app.inject({
      method: 'POST',
      url: '/api/community-issues',
      payload: {
        repo: 'test/repo',
        issueNumber: 1,
        issueType: 'bug',
        title: 'First',
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues',
      payload: {
        repo: 'test/repo',
        issueNumber: 1,
        issueType: 'bug',
        title: 'Duplicate',
      },
    });
    assert.equal(res.statusCode, 409);
  });

  test('GET /api/community-issues?repo filters by repo', async () => {
    const app = await createApp();
    await app.inject({
      method: 'POST',
      url: '/api/community-issues',
      payload: {
        repo: 'a/b',
        issueNumber: 1,
        issueType: 'bug',
        title: 'Issue A',
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/community-issues',
      payload: {
        repo: 'c/d',
        issueNumber: 2,
        issueType: 'feature',
        title: 'Issue B',
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/community-issues?repo=a/b',
    });
    assert.equal(res.statusCode, 200);
    const { issues } = res.json();
    assert.equal(issues.length, 1);
    assert.equal(issues[0].repo, 'a/b');
  });

  test('GET /api/community-issues/:id returns item', async () => {
    const app = await createApp();
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/community-issues',
        payload: {
          repo: 'x/y',
          issueNumber: 10,
          issueType: 'question',
          title: 'Q',
        },
      })
    ).json();
    const res = await app.inject({
      method: 'GET',
      url: `/api/community-issues/${created.id}`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().id, created.id);
  });

  test('GET /api/community-issues/:id returns 404 for unknown', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/community-issues/nonexistent',
    });
    assert.equal(res.statusCode, 404);
  });

  test('PATCH /api/community-issues/:id updates state', async () => {
    const app = await createApp();
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/community-issues',
        payload: {
          repo: 'x/y',
          issueNumber: 11,
          issueType: 'bug',
          title: 'Bug',
        },
      })
    ).json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/community-issues/${created.id}`,
      payload: { state: 'discussing', replyState: 'replied' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().state, 'discussing');
    assert.equal(res.json().replyState, 'replied');
  });

  test('DELETE /api/community-issues/:id removes item', async () => {
    const app = await createApp();
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/community-issues',
        payload: {
          repo: 'x/y',
          issueNumber: 12,
          issueType: 'enhancement',
          title: 'Enh',
        },
      })
    ).json();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/community-issues/${created.id}`,
    });
    assert.equal(res.statusCode, 204);
  });

  test('GET /api/community-board returns 400 without repo', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/community-board',
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'Missing repo query parameter');
  });

  test('POST /api/community-issues/:id/dispatch transitions unreplied to discussing', async () => {
    const app = await createApp();
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/community-issues',
        payload: {
          repo: 'x/y',
          issueNumber: 99,
          issueType: 'feature',
          title: 'New feat',
        },
      })
    ).json();
    assert.equal(created.state, 'unreplied');

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${created.id}/dispatch`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.state, 'discussing');
    assert.equal(body.replyState, 'unreplied');
  });

  test('POST /api/community-issues/:id/dispatch stores threadId as assignedThreadId', async () => {
    const app = await createApp();
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/community-issues',
        payload: { repo: 'x/y', issueNumber: 100, issueType: 'feature', title: 'With thread' },
      })
    ).json();

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${created.id}/dispatch`,
      payload: { threadId: 'thread_abc' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.state, 'discussing');
    assert.equal(body.assignedThreadId, 'thread_abc');
  });

  test('POST /api/community-issues/:id/dispatch returns 404 for unknown', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/community-issues/nonexistent/dispatch',
    });
    assert.equal(res.statusCode, 404);
  });

  test('POST /api/community-issues/:id/dispatch returns 409 if already assigned', async () => {
    const app = await createApp();
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/community-issues',
        payload: {
          repo: 'x/y',
          issueNumber: 100,
          issueType: 'bug',
          title: 'Already assigned',
        },
      })
    ).json();
    await app.inject({
      method: 'PATCH',
      url: `/api/community-issues/${created.id}`,
      payload: { state: 'discussing' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${created.id}/dispatch`,
    });
    assert.equal(res.statusCode, 409);
  });

  test('GET /api/community-board returns issues + empty prItems', async () => {
    const app = await createApp();
    await app.inject({
      method: 'POST',
      url: '/api/community-issues',
      payload: {
        repo: 'zts212653/clowder-ai',
        issueNumber: 100,
        issueType: 'feature',
        title: 'Board test',
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/community-board?repo=zts212653/clowder-ai',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.repo, 'zts212653/clowder-ai');
    assert.ok(Array.isArray(body.issues));
    assert.ok(body.issues.length >= 1);
    assert.ok(Array.isArray(body.prItems));
  });

  test('GET /api/community-repos returns unique repo names', async () => {
    const app = await createApp();
    await app.inject({
      method: 'POST',
      url: '/api/community-issues',
      payload: { repo: 'org/alpha', issueNumber: 1, issueType: 'bug', title: 'A1' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/community-issues',
      payload: { repo: 'org/beta', issueNumber: 2, issueType: 'feature', title: 'B1' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/community-issues',
      payload: { repo: 'org/alpha', issueNumber: 3, issueType: 'question', title: 'A2' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/community-repos',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.repos));
    assert.equal(body.repos.length, 2);
    assert.ok(body.repos.includes('org/alpha'));
    assert.ok(body.repos.includes('org/beta'));
  });

  // --- Phase A: triage-complete + dispatch + resolve ---

  const fivePass = [
    { id: 'Q1', result: 'PASS' },
    { id: 'Q2', result: 'PASS' },
    { id: 'Q3', result: 'PASS' },
    { id: 'Q4', result: 'PASS' },
    { id: 'Q5', result: 'PASS' },
  ];

  async function createAndDispatch(app, overrides = {}) {
    const issue = (
      await app.inject({
        method: 'POST',
        url: '/api/community-issues',
        payload: { repo: 'org/repo', issueNumber: 1, issueType: 'feature', title: 'Test', ...overrides },
      })
    ).json();
    await app.inject({ method: 'POST', url: `/api/community-issues/${issue.id}/dispatch` });
    return issue;
  }

  test('POST triage-complete records first entry, returns await-second-cat', async () => {
    const app = await createApp();
    const issue = await createAndDispatch(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${issue.id}/triage-complete`,
      payload: { catId: 'opus', verdict: 'WELCOME', questions: fivePass },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().action, 'await-second-cat');
  });

  test('POST triage-complete resolves bugfix immediately', async () => {
    const app = await createApp();
    const issue = await createAndDispatch(app, { issueType: 'bug', issueNumber: 2 });
    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${issue.id}/triage-complete`,
      payload: { catId: 'opus', verdict: 'WELCOME', questions: fivePass },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().action, 'resolved');
    assert.equal(res.json().consensus.needsOwner, false);
  });

  test('POST triage-complete second entry resolves consensus', async () => {
    const app = await createApp();
    const issue = await createAndDispatch(app, { issueNumber: 3 });
    await app.inject({
      method: 'POST',
      url: `/api/community-issues/${issue.id}/triage-complete`,
      payload: { catId: 'opus', verdict: 'WELCOME', questions: fivePass },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${issue.id}/triage-complete`,
      payload: { catId: 'codex', verdict: 'WELCOME', questions: fivePass },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.action, 'resolved');
    assert.equal(body.consensus.verdict, 'WELCOME');
  });

  test('triage-complete rejects if issue not dispatched', async () => {
    const app = await createApp();
    const issue = (
      await app.inject({
        method: 'POST',
        url: '/api/community-issues',
        payload: { repo: 'org/repo', issueNumber: 4, issueType: 'feature', title: 'Not dispatched' },
      })
    ).json();
    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${issue.id}/triage-complete`,
      payload: { catId: 'opus', verdict: 'WELCOME', questions: fivePass },
    });
    assert.equal(res.statusCode, 409);
  });

  test('triage-complete validates payload', async () => {
    const app = await createApp();
    const issue = await createAndDispatch(app, { issueNumber: 5 });
    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${issue.id}/triage-complete`,
      payload: { catId: 'opus' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('POST resolve accepts pending-decision issue', async () => {
    const app = await createApp();
    const issue = await createAndDispatch(app, { issueNumber: 6 });
    await app.inject({
      method: 'POST',
      url: `/api/community-issues/${issue.id}/triage-complete`,
      payload: { catId: 'opus', verdict: 'WELCOME', questions: fivePass },
    });
    await app.inject({
      method: 'POST',
      url: `/api/community-issues/${issue.id}/triage-complete`,
      payload: { catId: 'codex', verdict: 'POLITELY-DECLINE', questions: fivePass, reasonCode: 'NOT_NOW' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${issue.id}/resolve`,
      payload: { decision: 'accepted' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().state, 'accepted');
  });

  test('POST resolve declines pending-decision issue', async () => {
    const app = await createApp();
    const issue = await createAndDispatch(app, { issueNumber: 7 });
    await app.inject({
      method: 'POST',
      url: `/api/community-issues/${issue.id}/triage-complete`,
      payload: { catId: 'opus', verdict: 'WELCOME', questions: fivePass },
    });
    await app.inject({
      method: 'POST',
      url: `/api/community-issues/${issue.id}/triage-complete`,
      payload: { catId: 'codex', verdict: 'NEEDS-DISCUSSION', questions: fivePass },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${issue.id}/resolve`,
      payload: { decision: 'declined' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().state, 'declined');
  });

  test('POST resolve accepted with relatedFeature + threadId links thread', async () => {
    const app = await createApp();
    const issue = await createAndDispatch(app, { issueNumber: 9 });
    await app.inject({
      method: 'POST',
      url: `/api/community-issues/${issue.id}/triage-complete`,
      payload: { catId: 'opus', verdict: 'WELCOME', questions: fivePass },
    });
    await app.inject({
      method: 'POST',
      url: `/api/community-issues/${issue.id}/triage-complete`,
      payload: { catId: 'codex', verdict: 'POLITELY-DECLINE', questions: fivePass, reasonCode: 'UNSURE' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${issue.id}/resolve`,
      headers: { 'x-cat-cafe-user': 'you' },
      payload: { decision: 'accepted', relatedFeature: 'F056', threadId: 'thread_f056' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.state, 'accepted');
    assert.equal(body.relatedFeature, 'F056');
    assert.equal(body.assignedThreadId, 'thread_f056');
  });

  test('POST resolve rejects if not pending-decision', async () => {
    const app = await createApp();
    const issue = (
      await app.inject({
        method: 'POST',
        url: '/api/community-issues',
        payload: { repo: 'org/repo', issueNumber: 8, issueType: 'feature', title: 'Not pending' },
      })
    ).json();
    const res = await app.inject({
      method: 'POST',
      url: `/api/community-issues/${issue.id}/resolve`,
      payload: { decision: 'accepted' },
    });
    assert.equal(res.statusCode, 409);
  });

  test('GET /api/community-repos includes repos from pr_tracking tasks', async () => {
    const app = await createApp();
    await app.inject({
      method: 'POST',
      url: '/api/community-issues',
      payload: { repo: 'org/alpha', issueNumber: 1, issueType: 'bug', title: 'A1' },
    });
    taskStore.create({
      kind: 'pr_tracking',
      threadId: 'thread_test',
      title: 'feat: gamma feature',
      subjectKey: 'pr:org/gamma#10',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/community-repos',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.repos.includes('org/alpha'), 'should include issue repo');
    assert.ok(body.repos.includes('org/gamma'), 'should include PR-only repo');
  });
});
