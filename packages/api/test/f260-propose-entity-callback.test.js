/**
 * F260 Phase A T1: propose-entity callback route test.
 *
 * Tests POST /api/callbacks/propose-entity with schema validation
 * (stance enum, visibility_scope, provenance with thread anchor).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('F260 propose-entity callback route', () => {
  let app;
  let InMemoryEntityProposalStore;
  let callbackProposeEntityRoutes;

  beforeEach(async () => {
    ({ InMemoryEntityProposalStore } = await import(
      '../dist/domains/approval-hub/stores/ports/IEntityProposalStore.js'
    ));
    ({ callbackProposeEntityRoutes } = await import('../dist/routes/callback-propose-entity-routes.js'));
    app = Fastify();

    // Stub the callback auth prehandler to always succeed
    app.addHook('preHandler', (request, _reply, done) => {
      request.callbackAuth = {
        invocationId: 'inv-test-1',
        callbackToken: 'tok-test',
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
        clientMessageIds: new Set(),
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      };
      done();
    });
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  const mockSocketManager = () => ({
    emitToUser: () => {},
  });

  // Mock registry — never called because the parent preHandler stub sets
  // request.callbackAuth before the plugin's own registerCallbackAuthHook runs.
  const mockRegistry = { verify: () => ({ ok: false, reason: 'not_reached' }) };

  /** Mock ingress that succeeds — commits envelope so publication becomes anchored. */
  const mockIngress = () => ({
    async publish(draft, store) {
      const envelope = {
        canonicalProposalId: draft.canonicalProposalId,
        sourceFeatureId: draft.producerId,
        ownerUserId: draft.ownerUserId,
        requesterCatId: draft.requesterCatId,
        originRef: draft.originRef,
        approvalCardRef: { threadId: draft.cardThreadId, messageId: 'msg-card-mock' },
        createdAt: draft.createdAt,
      };
      await store.commitEnvelope(draft.canonicalProposalId, envelope);
      return envelope;
    },
  });

  const registerRoutes = async (store) => {
    await app.register(callbackProposeEntityRoutes, {
      registry: mockRegistry,
      entityProposalStore: store,
      socketManager: mockSocketManager(),
      approvalIngress: mockIngress(),
    });
    return app.ready();
  };

  const validBody = {
    entityId: 'concept:未婚喵',
    entityType: 'concept',
    canonicalName: '未婚喵',
    aliases: ['未婚喵', '未婚猫'],
    stance: 'endorsed',
    visibilityScope: 'workspace',
    provenance: [{ source: 'cat-proposed', anchor: 'thread_abc' }],
    rationale: 'Recurring term in discussions',
    clientRequestId: 'entity-callback-valid',
  };

  it('creates a pending entity proposal and returns proposalId', async () => {
    const store = new InMemoryEntityProposalStore();
    await registerRoutes(store);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-entity',
      payload: validBody,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.proposalId, 'must return proposalId');
    assert.equal(body.status, 'pending');
    assert.equal(body.entityId, 'concept:未婚喵');

    // Verify stored in proposal store
    const stored = store.get(body.proposalId);
    assert.ok(stored, 'proposal must be stored');
    assert.equal(stored.sourceCatId, 'opus');
    assert.equal(stored.sourceThreadId, 'thread-abc');
    assert.equal(stored.ownerUserId, 'user-1');
  });

  it('returns retryable while a concurrent winner is still staged', async () => {
    class ConcurrentRaceStore extends InMemoryEntityProposalStore {
      getDedupProposalId() {
        // Force both requests through reserveDedup so this test exercises the
        // post-reservation loser branch instead of the cached fast path.
        return null;
      }
    }

    const store = new ConcurrentRaceStore();
    let publishStarted;
    const started = new Promise((resolve) => {
      publishStarted = resolve;
    });
    let releasePublish;
    const canPublish = new Promise((resolve) => {
      releasePublish = resolve;
    });
    const ingress = {
      async publish(draft, publicationStore) {
        publishStarted();
        await canPublish;
        return mockIngress().publish(draft, publicationStore);
      },
    };
    await app.register(callbackProposeEntityRoutes, {
      registry: mockRegistry,
      entityProposalStore: store,
      socketManager: mockSocketManager(),
      approvalIngress: ingress,
    });
    await app.ready();

    const payload = { ...validBody, clientRequestId: 'concurrent-staged' };
    const winnerPromise = app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-entity',
      payload,
    });
    await started;

    const loser = await app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-entity',
      payload,
    });
    assert.equal(loser.statusCode, 503, 'staged winner must not be reported as a successful dedup hit');
    assert.equal(loser.json().status, 'retryable');
    assert.equal(loser.headers['retry-after'], '1');

    releasePublish();
    const winner = await winnerPromise;
    assert.equal(winner.statusCode, 200);

    const anchoredRetry = await app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-entity',
      payload,
    });
    assert.equal(anchoredRetry.statusCode, 200, 'anchored winner may be returned as deduped success');
    assert.equal(anchoredRetry.json().deduped, true);
    assert.equal(anchoredRetry.json().proposalId, winner.json().proposalId);
  });

  describe('auth hook integration (no parent stub — exercises the plugin-scoped registerCallbackAuthHook)', () => {
    // These tests use a FRESH Fastify instance without the parent preHandler stub,
    // so the plugin's own registerCallbackAuthHook must fire. If the Fastify
    // encapsulation bug regresses, these tests will fail with 401.
    it('verifies credentials via registry and populates record provenance', async () => {
      const freshApp = Fastify();
      const store = new InMemoryEntityProposalStore();
      let verifyCalls = 0;
      const verifiedRecord = {
        invocationId: 'inv-integration-1',
        callbackToken: 'tok-integration',
        catId: 'fable-5',
        threadId: 'thread-integration',
        userId: 'user-integration',
        clientMessageIds: new Set(),
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      };
      const realRegistry = {
        verify: async (invocationId, callbackToken) => {
          verifyCalls++;
          if (invocationId === 'inv-integration-1' && callbackToken === 'tok-integration') {
            return { ok: true, record: verifiedRecord };
          }
          return { ok: false, reason: 'unknown_invocation' };
        },
      };
      await freshApp.register(callbackProposeEntityRoutes, {
        registry: realRegistry,
        entityProposalStore: store,
        socketManager: mockSocketManager(),
        approvalIngress: mockIngress(),
      });
      await freshApp.ready();

      const res = await freshApp.inject({
        method: 'POST',
        url: '/api/callbacks/propose-entity',
        headers: {
          'x-invocation-id': 'inv-integration-1',
          'x-callback-token': 'tok-integration',
          'content-type': 'application/json',
        },
        payload: validBody,
      });

      assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
      assert.equal(verifyCalls, 1, 'registry.verify must be called exactly once');
      const body = JSON.parse(res.body);
      assert.ok(body.proposalId);

      // Provenance must come from the verified record, not a stub
      const stored = store.get(body.proposalId);
      assert.equal(stored.sourceCatId, 'fable-5', 'sourceCatId must match verified record');
      assert.equal(stored.sourceThreadId, 'thread-integration', 'sourceThreadId must match verified record');
      assert.equal(stored.ownerUserId, 'user-integration', 'ownerUserId must match verified record');
      await freshApp.close();
    });

    it('returns 401 when registry rejects credentials', async () => {
      const freshApp = Fastify();
      const store = new InMemoryEntityProposalStore();
      const rejectRegistry = {
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      };
      await freshApp.register(callbackProposeEntityRoutes, {
        registry: rejectRegistry,
        entityProposalStore: store,
        socketManager: mockSocketManager(),
        approvalIngress: mockIngress(),
      });
      await freshApp.ready();

      const res = await freshApp.inject({
        method: 'POST',
        url: '/api/callbacks/propose-entity',
        headers: {
          'x-invocation-id': 'inv-bad',
          'x-callback-token': 'tok-bad',
          'content-type': 'application/json',
        },
        payload: validBody,
      });

      assert.equal(res.statusCode, 401);
      await freshApp.close();
    });
  });

  describe('schema validation', () => {
    it('accepts all stance values including negative ones', async () => {
      const store = new InMemoryEntityProposalStore();
      await registerRoutes(store);

      for (const stance of ['endorsed', 'rejected', 'critique_target', 'deliverable_only', 'unknown']) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/callbacks/propose-entity',
          payload: { ...validBody, stance, clientRequestId: `entity-stance-${stance}` },
        });
        assert.equal(res.statusCode, 200, `stance "${stance}" should be accepted`);
      }
    });

    it('rejects invalid stance', async () => {
      const store = new InMemoryEntityProposalStore();
      await registerRoutes(store);

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/propose-entity',
        payload: { ...validBody, stance: 'invalid' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('requires visibilityScope', async () => {
      const store = new InMemoryEntityProposalStore();
      await registerRoutes(store);

      const { visibilityScope, ...missing } = validBody;
      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/propose-entity',
        payload: missing,
      });
      assert.equal(res.statusCode, 400);
    });

    it('rejects private visibility scope until visibility-aware resolver lands (KD-7 gate)', async () => {
      const store = new InMemoryEntityProposalStore();
      await registerRoutes(store);

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/propose-entity',
        payload: { ...validBody, visibilityScope: 'private:user-1' },
      });
      // Private entities must not enter registry until resolver supports visibility filtering.
      // Without a visibility gate, private aliases leak into global mention/search output.
      assert.equal(res.statusCode, 400);
    });

    it('rejects invalid visibility scope format', async () => {
      const store = new InMemoryEntityProposalStore();
      await registerRoutes(store);

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/propose-entity',
        payload: { ...validBody, visibilityScope: 'global' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('requires provenance with at least one entry', async () => {
      const store = new InMemoryEntityProposalStore();
      await registerRoutes(store);

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/propose-entity',
        payload: { ...validBody, provenance: [] },
      });
      assert.equal(res.statusCode, 400);
    });

    it('requires aliases with at least one entry', async () => {
      const store = new InMemoryEntityProposalStore();
      await registerRoutes(store);

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/propose-entity',
        payload: { ...validBody, aliases: [] },
      });
      assert.equal(res.statusCode, 400);
    });

    it('requires rationale', async () => {
      const store = new InMemoryEntityProposalStore();
      await registerRoutes(store);

      const { rationale, ...missing } = validBody;
      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/propose-entity',
        payload: missing,
      });
      assert.equal(res.statusCode, 400);
    });
  });
});
