import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('GET /api/approval-hub/pending', () => {
  let app;
  let proposalStore;
  let handoffStore;

  beforeEach(async () => {
    const { InMemoryProposalStore } = await import('../../dist/domains/cats/services/stores/ports/ProposalStore.js');
    const { InMemorySessionHandoffProposalStore } = await import(
      '../../dist/domains/cats/services/stores/ports/SessionHandoffProposalStore.js'
    );
    const { F128ApprovalAdapter } = await import('../../dist/domains/approval-hub/adapters/F128ApprovalAdapter.js');
    const { F225ApprovalAdapter } = await import('../../dist/domains/approval-hub/adapters/F225ApprovalAdapter.js');
    const { approvalHubRoutes } = await import('../../dist/routes/approval-hub-routes.js');

    proposalStore = new InMemoryProposalStore();
    handoffStore = new InMemorySessionHandoffProposalStore();

    app = Fastify();
    await app.register(approvalHubRoutes, {
      adapters: [new F128ApprovalAdapter(proposalStore), new F225ApprovalAdapter(handoffStore)],
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns aggregated pending items from F128 + F225 adapters', async () => {
    // Create one F128 pending
    proposalStore.create({
      sourceThreadId: 't-1',
      sourceInvocationId: 'inv-1',
      sourceCatId: 'opus',
      title: 'New thread',
      reason: 'reason',
      parentThreadId: 'p-1',
      preferredCats: ['opus'],
      projectPath: '/p',
      createdBy: 'user-1',
    });
    // Create one F225 pending
    handoffStore.create({
      userId: 'user-1',
      sourceCatId: 'sonnet',
      sourceThreadId: 't-2',
      sourceSessionId: 's-1',
      note: { done: 'Task done', nextSteps: 'Continue' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/approval-hub/pending',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.count, 2);
    assert.equal(body.items.length, 2);
    const featureIds = body.items.map((i) => i.sourceFeatureId).sort();
    assert.deepEqual(featureIds, ['F128', 'F225']);
    assert.ok(body.items.every((i) => i.ownerUserId === 'user-1'));
  });

  it('returns 401 without user identity', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/approval-hub/pending',
    });
    assert.equal(res.statusCode, 401);
  });

  it('sorts by createdAt descending across features', async () => {
    // Create F128 first (older)
    proposalStore.create({
      sourceThreadId: 't-1',
      sourceInvocationId: 'inv-1',
      sourceCatId: 'opus',
      title: 'Older thread',
      reason: 'r',
      parentThreadId: 'p',
      preferredCats: [],
      projectPath: '/p',
      createdBy: 'user-1',
    });
    // Create F225 second (newer)
    handoffStore.create({
      userId: 'user-1',
      sourceCatId: 'sonnet',
      sourceThreadId: 't-2',
      sourceSessionId: 's-1',
      note: { done: 'Newer task', nextSteps: 'n' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/approval-hub/pending',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    const body = JSON.parse(res.body);
    assert.equal(body.items.length, 2);
    assert.ok(body.items[0].createdAt >= body.items[1].createdAt, 'newest first');
  });

  it('returns empty when no pending items', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/approval-hub/pending',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    const body = JSON.parse(res.body);
    assert.equal(body.count, 0);
    assert.deepEqual(body.items, []);
  });

  it('filters by user — does not leak other users proposals', async () => {
    proposalStore.create({
      sourceThreadId: 't-1',
      sourceInvocationId: 'inv-1',
      sourceCatId: 'opus',
      title: 'Thread for user-2',
      reason: 'r',
      parentThreadId: 'p',
      preferredCats: [],
      projectPath: '/p',
      createdBy: 'user-2',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/approval-hub/pending',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    const body = JSON.parse(res.body);
    assert.equal(body.count, 0, 'user-1 should not see user-2 proposals');
  });
});
