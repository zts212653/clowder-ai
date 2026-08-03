import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { anchorApproval, createTestApprovalRegistry } from './helpers.js';

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
      registry: await createTestApprovalRegistry([
        new F128ApprovalAdapter(proposalStore),
        new F225ApprovalAdapter(handoffStore),
      ]),
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns aggregated pending items from F128 + F225 adapters', async () => {
    // Create one F128 pending
    const threadProposal = proposalStore.create({
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
    const handoffProposal = handoffStore.create({
      userId: 'user-1',
      sourceCatId: 'sonnet',
      sourceThreadId: 't-2',
      sourceSessionId: 's-1',
      note: { done: 'Task done', nextSteps: 'Continue' },
    });
    anchorApproval(proposalStore, {
      proposalId: threadProposal.proposalId,
      sourceFeatureId: 'F128',
      ownerUserId: 'user-1',
      requesterCatId: 'opus',
      threadId: 't-1',
      createdAt: threadProposal.createdAt,
    });
    anchorApproval(handoffStore, {
      proposalId: handoffProposal.proposalId,
      sourceFeatureId: 'F225',
      ownerUserId: 'user-1',
      requesterCatId: 'sonnet',
      threadId: 't-2',
      createdAt: handoffProposal.createdAt,
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
    assert.deepEqual(
      body.manifest.map((entry) => entry.id),
      ['F128', 'F139', 'F225', 'F193', 'F231', 'F260', 'F221', 'F276'],
    );
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
    const older = proposalStore.create({
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
    const newer = handoffStore.create({
      userId: 'user-1',
      sourceCatId: 'sonnet',
      sourceThreadId: 't-2',
      sourceSessionId: 's-1',
      note: { done: 'Newer task', nextSteps: 'n' },
    });
    anchorApproval(proposalStore, {
      proposalId: older.proposalId,
      sourceFeatureId: 'F128',
      ownerUserId: 'user-1',
      requesterCatId: 'opus',
      threadId: 't-1',
      createdAt: older.createdAt,
    });
    anchorApproval(handoffStore, {
      proposalId: newer.proposalId,
      sourceFeatureId: 'F225',
      ownerUserId: 'user-1',
      requesterCatId: 'sonnet',
      threadId: 't-2',
      createdAt: newer.createdAt,
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
    const otherUserProposal = proposalStore.create({
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
    anchorApproval(proposalStore, {
      proposalId: otherUserProposal.proposalId,
      sourceFeatureId: 'F128',
      ownerUserId: 'user-2',
      requesterCatId: 'opus',
      threadId: 't-1',
      createdAt: otherUserProposal.createdAt,
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

describe('F246 approval fan-out telemetry and failure policy', () => {
  let app;
  let logs;

  afterEach(async () => {
    if (app) await app.close();
  });

  async function buildApp(adapters) {
    const { approvalHubRoutes } = await import('../../dist/routes/approval-hub-routes.js');
    logs = [];
    app = Fastify({
      logger: {
        level: 'info',
        stream: {
          write(line) {
            logs.push(JSON.parse(line));
          },
        },
      },
    });
    await app.register(approvalHubRoutes, { registry: await createTestApprovalRegistry(adapters) });
    await app.ready();
  }

  function measurementLogs(query) {
    return logs.filter(
      (entry) => entry.feature === 'F246' && entry.measurement === 'approval_hub_fanout' && entry.query === query,
    );
  }

  it('records bounded per-adapter and total duration, item count, producer, and outcome', async () => {
    await buildApp([
      {
        featureId: 'F128',
        async listPending() {
          return [
            {
              proposalId: 'p-measured',
              sourceFeatureId: 'F128',
              requesterCatId: 'opus',
              ownerUserId: 'user-1',
              status: 'pending',
              summary: 'measured',
              detail: {},
              navigation: { state: 'legacy_unanchored', legacyThreadId: 'thread-1' },
              inlineApprovable: false,
              createdAt: 1,
            },
          ];
        },
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/approval-hub/pending',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(response.statusCode, 200);

    const measurements = measurementLogs('pending');
    const adapterMeasurements = measurements.filter((entry) => entry.scope === 'adapter');
    assert.equal(adapterMeasurements.length, 8);
    assert.deepEqual(adapterMeasurements.map((entry) => entry.producerId).sort(), [
      'F128',
      'F139',
      'F193',
      'F221',
      'F225',
      'F231',
      'F260',
      'F276',
    ]);
    const f128 = adapterMeasurements.find((entry) => entry.producerId === 'F128');
    assert.equal(f128.itemCount, 1);
    assert.equal(f128.outcome, 'success');
    assert.equal(typeof f128.durationMs, 'number');

    const total = measurements.find((entry) => entry.scope === 'total');
    assert.equal(total.producerId, 'all');
    assert.equal(total.itemCount, 1);
    assert.equal(total.outcome, 'success');
    assert.equal(typeof total.durationMs, 'number');
  });

  it('attributes a failing adapter and fails the whole request instead of returning a silent partial result', async () => {
    await buildApp([
      {
        featureId: 'F128',
        async listPending() {
          throw new Error('f128 unavailable');
        },
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/approval-hub/pending',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(response.statusCode, 500);

    const measurements = measurementLogs('pending');
    const failedAdapter = measurements.find((entry) => entry.scope === 'adapter' && entry.producerId === 'F128');
    assert.equal(failedAdapter.outcome, 'error');
    assert.equal(failedAdapter.itemCount, 0);
    const total = measurements.find((entry) => entry.scope === 'total');
    assert.equal(total.outcome, 'error');
    assert.equal(total.producerId, 'all');
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
      registry: await createTestApprovalRegistry([new F193ApprovalAdapter(dispatchStore)]),
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
    assert.equal(body.manifest.length, 8);
  });

  /** Create + anchor a dispatch proposal so settled adapter projection works. */
  const createAndAnchor = async (overrides = {}) => {
    const input = {
      proposalId: 'p-default',
      sourceThreadId: 's',
      targetThreadId: 't',
      senderCatId: 'opus',
      ownerUserId: 'user-1',
      content: 'test',
      targetCats: [],
      createdAt: Date.now(),
      ...overrides,
    };
    const { proposal } = await dispatchStore.create(input);
    anchorApproval(dispatchStore, {
      proposalId: proposal.proposalId,
      sourceFeatureId: 'F193',
      ownerUserId: proposal.ownerUserId,
      requesterCatId: proposal.senderCatId,
      threadId: proposal.sourceThreadId,
      createdAt: proposal.createdAt,
    });
    return proposal;
  };

  it('returns settled proposals sorted by decidedAt desc', async () => {
    const base = 1_700_000_000_000;
    // Create two proposals, approve them in reverse order to test sorting
    await createAndAnchor({
      proposalId: 'p-1',
      targetThreadId: 'thread-A',
      content: 'older',
      createdAt: base,
    });
    await createAndAnchor({
      proposalId: 'p-2',
      targetThreadId: 'thread-B',
      content: 'newer',
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
    await createAndAnchor({
      proposalId: 'p-x',
      targetThreadId: 't',
      ownerUserId: 'user-2',
      content: 'secret',
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
      await createAndAnchor({
        proposalId: `p-${i}`,
        targetThreadId: `t-${i}`,
        content: `item ${i}`,
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
    await createAndAnchor({
      proposalId: 'pa',
      targetThreadId: 'thread-A',
      content: 'approved',
      createdAt: 1_700_000_000_000,
    });
    await createAndAnchor({
      proposalId: 'pr',
      targetThreadId: 'thread-B',
      content: 'rejected',
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
    await createAndAnchor({
      proposalId: 'p-frac',
      targetThreadId: 't',
      content: 'fractional limit test',
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
      await createAndAnchor({
        proposalId: `p-frac2-${i}`,
        targetThreadId: `t-frac2-${i}`,
        content: `item ${i}`,
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
