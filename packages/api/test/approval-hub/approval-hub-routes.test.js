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

// F246 Phase F: Approval history route
describe('GET /api/approval-hub/settled', () => {
  let app;
  let dispatchStore;

  beforeEach(async () => {
    const { InMemoryDispatchProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'
    );
    const { F193ApprovalAdapter } = await import('../../dist/domains/approval-hub/adapters/F193ApprovalAdapter.js');
    const { approvalHubRoutes } = await import('../../dist/routes/approval-hub-routes.js');

    dispatchStore = new InMemoryDispatchProposalStore();

    app = Fastify();
    await app.register(approvalHubRoutes, {
      adapters: [new F193ApprovalAdapter(dispatchStore)],
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns 401 without user identity', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/approval-hub/settled' });
    assert.equal(res.statusCode, 401);
  });

  it('returns empty array when no settled proposals', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/approval-hub/settled',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.count, 0);
    assert.deepEqual(body.items, []);
  });

  it('returns settled proposals sorted by decidedAt desc', async () => {
    const base = 1_700_000_000_000;
    // Create two proposals, approve them in reverse order to test sorting
    await dispatchStore.create({
      proposalId: 'p-1',
      sourceThreadId: 's',
      targetThreadId: 't',
      senderCatId: 'opus',
      ownerUserId: 'user-1',
      content: 'older',
      targetCats: [],
      createdAt: base,
    });
    await dispatchStore.create({
      proposalId: 'p-2',
      sourceThreadId: 's',
      targetThreadId: 't',
      senderCatId: 'opus',
      ownerUserId: 'user-1',
      content: 'newer',
      targetCats: [],
      createdAt: base + 1,
    });

    await dispatchStore.approve('p-1', 'user-1');
    await dispatchStore.approve('p-2', 'user-1');

    const res = await app.inject({
      method: 'GET',
      url: '/api/approval-hub/settled',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    const body = JSON.parse(res.body);
    assert.equal(body.count, 2);
    assert.ok(body.items[0].decidedAt >= body.items[1].decidedAt, 'newest first');
    assert.ok(body.items.every((i) => i.status === 'approved'));
  });

  it('does not leak settled proposals to other users', async () => {
    await dispatchStore.create({
      proposalId: 'p-x',
      sourceThreadId: 's',
      targetThreadId: 't',
      senderCatId: 'opus',
      ownerUserId: 'user-2',
      content: 'secret',
      targetCats: [],
      createdAt: 1_700_000_000_000,
    });
    await dispatchStore.approve('p-x', 'user-2');

    const res = await app.inject({
      method: 'GET',
      url: '/api/approval-hub/settled',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    const body = JSON.parse(res.body);
    assert.equal(body.count, 0, 'user-1 must not see user-2 settled proposals');
  });

  it('respects ?limit query param', async () => {
    const base = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) {
      await dispatchStore.create({
        proposalId: `p-${i}`,
        sourceThreadId: 's',
        targetThreadId: 't',
        senderCatId: 'opus',
        ownerUserId: 'user-1',
        content: `item ${i}`,
        targetCats: [],
        createdAt: base + i,
      });
      await dispatchStore.approve(`p-${i}`, 'user-1');
    }

    const res = await app.inject({
      method: 'GET',
      url: '/api/approval-hub/settled?limit=3',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    const body = JSON.parse(res.body);
    assert.equal(body.count, 3, 'limit=3 should cap results');
  });

  it('returns both approved and rejected in the history', async () => {
    await dispatchStore.create({
      proposalId: 'pa',
      sourceThreadId: 's',
      targetThreadId: 't',
      senderCatId: 'opus',
      ownerUserId: 'user-1',
      content: 'approved',
      targetCats: [],
      createdAt: 1_700_000_000_000,
    });
    await dispatchStore.create({
      proposalId: 'pr',
      sourceThreadId: 's',
      targetThreadId: 't',
      senderCatId: 'opus',
      ownerUserId: 'user-1',
      content: 'rejected',
      targetCats: [],
      createdAt: 1_700_000_000_001,
    });

    await dispatchStore.approve('pa', 'user-1');
    await dispatchStore.reject('pr', 'user-1');

    const res = await app.inject({
      method: 'GET',
      url: '/api/approval-hub/settled',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    const body = JSON.parse(res.body);
    assert.equal(body.count, 2);
    const statuses = body.items.map((i) => i.status).sort();
    assert.deepEqual(statuses, ['approved', 'rejected']);
  });

  it('coerces fractional limit to integer — limit=0.9 must default (floor=0, P2 fix)', async () => {
    // P2 cloud finding: non-integer limit sent to Redis ZREVRANGE causes 500.
    // Route must floor() before fan-out. limit=0.9 → floor=0 → invalid → DEFAULT_SETTLED_LIMIT.
    // With InMemory the slice() truncates silently; this test catches the route-level coercion.
    await dispatchStore.create({
      proposalId: 'p-frac',
      sourceThreadId: 's',
      targetThreadId: 't',
      senderCatId: 'opus',
      ownerUserId: 'user-1',
      content: 'fractional limit test',
      targetCats: [],
      createdAt: Date.now(),
    });
    await dispatchStore.approve('p-frac', 'user-1');

    const res = await app.inject({
      method: 'GET',
      url: '/api/approval-hub/settled?limit=0.9',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200, 'fractional limit must not 500');
    const body = JSON.parse(res.body);
    // floor(0.9) = 0 → invalid → falls back to DEFAULT_SETTLED_LIMIT (50) → returns the 1 item we have
    assert.equal(body.count, 1, 'should fall back to default limit and return the approved item');
  });

  it('coerces fractional limit to integer — limit=1.5 must floor to 1 (P2 fix)', async () => {
    // floor(1.5) = 1 → valid → returns at most 1 item
    const base = Date.now();
    for (let i = 0; i < 3; i++) {
      await dispatchStore.create({
        proposalId: `p-frac2-${i}`,
        sourceThreadId: 's',
        targetThreadId: 't',
        senderCatId: 'opus',
        ownerUserId: 'user-1',
        content: `item ${i}`,
        targetCats: [],
        createdAt: base + i,
      });
      await dispatchStore.approve(`p-frac2-${i}`, 'user-1');
    }

    const res = await app.inject({
      method: 'GET',
      url: '/api/approval-hub/settled?limit=1.5',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200, 'fractional limit must not 500');
    const body = JSON.parse(res.body);
    assert.equal(body.count, 1, 'floor(1.5)=1 → at most 1 item returned');
  });
});
