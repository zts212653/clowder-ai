import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

describe('Community decision queue finding action routes (F168 Phase E E-PR1)', () => {
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

  test('POST /api/community-findings/:id/acknowledge transitions open finding', async () => {
    const findingStore = createFindingStore([finding()]);
    const app = await createApp({ findingStore });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-findings/finding-open/acknowledge',
      headers: { 'x-cat-cafe-user': 'case-owner' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().finding.status, 'acknowledged');
    assert.equal((await findingStore.get('finding-open')).status, 'acknowledged');
  });

  test('POST /api/community-findings/:id/resolve transitions acknowledged finding', async () => {
    const findingStore = createFindingStore([finding({ status: 'acknowledged' })]);
    const app = await createApp({ findingStore });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-findings/finding-open/resolve',
      headers: { 'x-cat-cafe-user': 'case-owner' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().finding.status, 'resolved');
  });

  test('POST /api/community-findings/:id/waive requires reason and evidence', async () => {
    const app = await createApp({ findingStore: createFindingStore([finding()]) });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-findings/finding-open/waive',
      headers: { 'x-cat-cafe-user': 'case-owner' },
      payload: { reason: 'ok', actor: 'codex' },
    });

    assert.equal(res.statusCode, 400);
  });

  test('finding action endpoints return 501 when findingStore is not configured', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/community-findings/finding-open/acknowledge',
      headers: { 'x-cat-cafe-user': 'case-owner' },
    });

    assert.equal(res.statusCode, 501);
  });

  test('finding action endpoints return 404 when finding is missing', async () => {
    const app = await createApp({ findingStore: createFindingStore([]) });
    const res = await app.inject({
      method: 'POST',
      url: '/api/community-findings/missing/acknowledge',
      headers: { 'x-cat-cafe-user': 'case-owner' },
    });

    assert.equal(res.statusCode, 404);
  });

  test('acknowledge resolved finding returns 409 without changing status', async () => {
    const findingStore = createFindingStore([finding({ status: 'resolved' })]);
    const app = await createApp({ findingStore });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-findings/finding-open/acknowledge',
      headers: { 'x-cat-cafe-user': 'case-owner' },
    });

    assert.equal(res.statusCode, 409);
    assert.equal((await findingStore.get('finding-open')).status, 'resolved');
  });

  test('resolve and different-audit waive on waived finding return 409 without changing status', async () => {
    const findingStore = createFindingStore([
      finding({
        status: 'waived',
        waiver: { reason: 'intentional', actor: 'opus', evidence: 'link' },
      }),
    ]);
    const app = await createApp({ findingStore });

    const resolveRes = await app.inject({
      method: 'POST',
      url: '/api/community-findings/finding-open/resolve',
      headers: { 'x-cat-cafe-user': 'case-owner' },
    });
    assert.equal(resolveRes.statusCode, 409);

    const waiveRes = await app.inject({
      method: 'POST',
      url: '/api/community-findings/finding-open/waive',
      headers: { 'x-cat-cafe-user': 'case-owner' },
      payload: { reason: 'again', actor: 'codex', evidence: 'link' },
    });
    assert.equal(waiveRes.statusCode, 409);
    assert.equal((await findingStore.get('finding-open')).status, 'waived');
  });

  test('same-audit waive on waived finding is idempotent', async () => {
    const findingStore = createFindingStore([
      finding({
        status: 'waived',
        waiver: { reason: 'intentional', actor: 'case-owner', evidence: 'link' },
      }),
    ]);
    const app = await createApp({ findingStore });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-findings/finding-open/waive',
      headers: { 'x-cat-cafe-user': 'case-owner' },
      payload: { reason: 'intentional', actor: 'spoofed-client', evidence: 'link' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().finding.status, 'waived');
    assert.deepEqual(res.json().finding.waiver, { reason: 'intentional', actor: 'case-owner', evidence: 'link' });
    assert.deepEqual((await findingStore.get('finding-open')).waiver, {
      reason: 'intentional',
      actor: 'case-owner',
      evidence: 'link',
    });
  });

  test('finding action endpoints reject unauthenticated mutations before writing', async () => {
    const findingStore = createFindingStore([finding()]);
    const app = await createApp({ findingStore });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-findings/finding-open/acknowledge',
    });

    assert.equal(res.statusCode, 401);
    assert.equal((await findingStore.get('finding-open')).status, 'open');
  });

  test('waive records actor from authenticated identity, not client payload', async () => {
    const findingStore = createFindingStore([finding()]);
    const app = await createApp({ findingStore });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-findings/finding-open/waive',
      headers: { 'x-cat-cafe-user': 'case-owner' },
      payload: { reason: 'intentional', actor: 'spoofed-client', evidence: 'link' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().finding.waiver.actor, 'case-owner');
  });

  test('waive records actor from callback-authenticated cat identity', async () => {
    const findingStore = createFindingStore([finding()]);
    const registry = {
      async verify(invocationId, callbackToken) {
        if (invocationId !== 'inv-1' || callbackToken !== 'token-1') {
          return { ok: false, reason: 'invalid_token' };
        }
        return {
          ok: true,
          record: {
            invocationId,
            callbackToken,
            userId: 'user-1',
            catId: 'codex',
            threadId: 'thread-1',
            clientMessageIds: new Set(),
            createdAt: 1,
            expiresAt: 9_999_999_999,
          },
        };
      },
    };
    const app = await createApp({ findingStore, registry });

    const res = await app.inject({
      method: 'POST',
      url: '/api/community-findings/finding-open/waive',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'token-1' },
      payload: { reason: 'intentional', actor: 'spoofed-client', evidence: 'link' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().finding.waiver.actor, 'codex');
  });
});
