import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/**
 * F222: Frustration issue routes tests.
 *
 * Uses Fastify inject() for route-level testing with InMemory store.
 */

let app;
let store;

const USER_HEADER = 'x-cat-cafe-user';
const DEFAULT_USER = 'user_test';

async function seedDraft(userId = DEFAULT_USER) {
  return store.create({
    threadId: 'thread_t1',
    userId,
    catId: 'cat-test',
    signalType: 'cli_error',
    signalDetail: { reasonCode: 'auth_failed' },
    context: { recentMessages: [] },
  });
}

describe('F222: frustration-issue-routes', () => {
  beforeEach(async () => {
    const Fastify = (await import('fastify')).default;
    const { InMemoryFrustrationIssueStore } = await import(
      '../../dist/domains/cats/services/stores/memory/InMemoryFrustrationIssueStore.js'
    );
    const { frustrationIssueRoutes } = await import('../../dist/routes/frustration-issue-routes.js');

    store = new InMemoryFrustrationIssueStore();
    app = Fastify();
    await app.register(frustrationIssueRoutes, { frustrationIssueStore: store });
    await app.ready();
  });

  // ── GET /status ────────────────────────────────────────────

  it('GET status: returns current persisted issue status after confirm', async () => {
    const issue = await seedDraft();
    await store.confirm({ issueId: issue.issueId, userDescription: 'Already sent' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/frustration-issues/${issue.issueId}/status`,
      headers: { [USER_HEADER]: DEFAULT_USER },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.issue.issueId, issue.issueId);
    assert.equal(body.issue.status, 'confirmed');
    assert.equal(body.issue.userDescription, 'Already sent');
  });

  it('GET status: 403 for wrong user', async () => {
    const issue = await seedDraft('user_alice');

    const res = await app.inject({
      method: 'GET',
      url: `/api/frustration-issues/${issue.issueId}/status`,
      headers: { [USER_HEADER]: 'user_bob' },
    });

    assert.equal(res.statusCode, 403);
  });

  // ── POST /confirm ──────────────────────────────────────────

  it('POST confirm: 200 + status=confirmed', async () => {
    const issue = await seedDraft();
    const res = await app.inject({
      method: 'POST',
      url: `/api/frustration-issues/${issue.issueId}/confirm`,
      headers: { [USER_HEADER]: DEFAULT_USER },
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.issue.status, 'confirmed');
  });

  it('POST confirm: sets userDescription', async () => {
    const issue = await seedDraft();
    const res = await app.inject({
      method: 'POST',
      url: `/api/frustration-issues/${issue.issueId}/confirm`,
      headers: { [USER_HEADER]: DEFAULT_USER },
      payload: { userDescription: 'Auth keeps failing on login' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.issue.userDescription, 'Auth keeps failing on login');
  });

  it('POST confirm: 404 for nonexistent issue', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/frustration-issues/fi_nonexistent/confirm',
      headers: { [USER_HEADER]: DEFAULT_USER },
      payload: {},
    });
    assert.equal(res.statusCode, 404);
  });

  it('POST confirm: 409 for already-confirmed issue', async () => {
    const issue = await seedDraft();
    await app.inject({
      method: 'POST',
      url: `/api/frustration-issues/${issue.issueId}/confirm`,
      headers: { [USER_HEADER]: DEFAULT_USER },
      payload: {},
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/frustration-issues/${issue.issueId}/confirm`,
      headers: { [USER_HEADER]: DEFAULT_USER },
      payload: {},
    });
    assert.equal(res.statusCode, 409);
  });

  it('POST confirm: 403 for wrong user', async () => {
    const issue = await seedDraft('user_alice');
    const res = await app.inject({
      method: 'POST',
      url: `/api/frustration-issues/${issue.issueId}/confirm`,
      headers: { [USER_HEADER]: 'user_bob' },
      payload: {},
    });
    assert.equal(res.statusCode, 403);
  });

  // ── POST /skip ─────────────────────────────────────────────

  it('POST skip: 200 + status=skipped', async () => {
    const issue = await seedDraft();
    const res = await app.inject({
      method: 'POST',
      url: `/api/frustration-issues/${issue.issueId}/skip`,
      headers: { [USER_HEADER]: DEFAULT_USER },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.issue.status, 'skipped');
  });

  it('POST skip: 404 for nonexistent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/frustration-issues/fi_nope/skip',
      headers: { [USER_HEADER]: DEFAULT_USER },
    });
    assert.equal(res.statusCode, 404);
  });

  it('POST skip: 409 for already-skipped', async () => {
    const issue = await seedDraft();
    await app.inject({
      method: 'POST',
      url: `/api/frustration-issues/${issue.issueId}/skip`,
      headers: { [USER_HEADER]: DEFAULT_USER },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/frustration-issues/${issue.issueId}/skip`,
      headers: { [USER_HEADER]: DEFAULT_USER },
    });
    assert.equal(res.statusCode, 409);
  });

  // ── GET /pending ───────────────────────────────────────────

  it('GET pending: returns draft issues for user', async () => {
    await seedDraft();
    await seedDraft();
    const confirmed = await seedDraft();
    await store.confirm({ issueId: confirmed.issueId });

    const res = await app.inject({
      method: 'GET',
      url: '/api/frustration-issues/pending',
      headers: { [USER_HEADER]: DEFAULT_USER },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.issues.length, 2);
    assert.ok(body.issues.every((i) => i.status === 'draft'));
  });

  it('GET pending: empty for user with no drafts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/frustration-issues/pending',
      headers: { [USER_HEADER]: 'user_nobody' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.issues.length, 0);
  });
});
