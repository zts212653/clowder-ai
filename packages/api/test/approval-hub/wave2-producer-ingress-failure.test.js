/**
 * F246 Phase I Wave 2: Ingress failure safety tests.
 *
 * P1-1: ingress.publish() failure must propagate as non-2xx (current code swallows).
 * P1-2: approvalIngress must be required — no legacy bypass (current code has `else` fallback).
 * P1-4: F193 supersede + publish failure must leave existing proposals actionable.
 *
 * RED snapshot: all tests FAIL against the pre-fix code because:
 *   - P1-1: current catch swallows → 200 instead of 500
 *   - P1-2: current `else` branch emits legacy socket → no error
 *   - P1-4: current code doesn't roll back superseded proposals
 *
 * [宪宪/Claude Opus 4.6🐾]
 */
import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** ApprovalIngress mock that always throws on publish. */
function createFailingIngress() {
  return {
    publish: async () => {
      throw new Error('simulated ingress failure: card append failed');
    },
  };
}

/** ApprovalIngress mock that succeeds (commits envelope via store). */
function createSucceedingIngress() {
  return {
    publish: async (draft, store) => {
      const envelope = {
        canonicalProposalId: draft.canonicalProposalId,
        sourceFeatureId: draft.producerId,
        ownerUserId: draft.ownerUserId,
        requesterCatId: draft.requesterCatId,
        originRef: draft.originRef,
        approvalCardRef: { threadId: draft.cardThreadId, messageId: 'msg-card-ok' },
        createdAt: draft.createdAt,
      };
      await store.commitEnvelope(draft.canonicalProposalId, envelope);
      return envelope;
    },
  };
}

// ── F260: Entity Proposal Ingress Failure ───────────────────────────────────

describe('P1-1/P1-2: F260 entity proposal ingress failure', () => {
  let InMemoryEntityProposalStore;
  let callbackProposeEntityRoutes;
  let app;

  beforeEach(async () => {
    ({ InMemoryEntityProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IEntityProposalStore.js'
    ));
    ({ callbackProposeEntityRoutes } = await import('../../dist/routes/callback-propose-entity-routes.js'));
    app = Fastify();

    // Stub callback auth
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

  afterEach(() => app?.close());

  const mockRegistry = { verify: () => ({ ok: false, reason: 'not_reached' }) };
  const mockSocket = () => ({ emitToUser: () => {} });

  const validBody = {
    entityId: 'concept:未婚喵',
    entityType: 'concept',
    canonicalName: '未婚喵',
    aliases: ['未婚喵', '未婚猫'],
    stance: 'endorsed',
    visibilityScope: 'workspace',
    provenance: [{ source: 'cat-proposed', anchor: 'thread_abc' }],
    rationale: 'Recurring term in discussions',
    clientRequestId: 'entity-ingress-failure',
  };

  it('returns non-2xx when ingress.publish throws (P1-1)', async () => {
    const store = new InMemoryEntityProposalStore();
    await app.register(callbackProposeEntityRoutes, {
      registry: mockRegistry,
      entityProposalStore: store,
      socketManager: mockSocket(),
      approvalIngress: createFailingIngress(),
    });
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/callbacks/propose-entity', payload: validBody });
    assert.ok(res.statusCode >= 500, `Expected 5xx but got ${res.statusCode}: ingress failure must propagate`);
  });

  it('proposal not anchored after ingress failure — Hub cannot show it (P1-1)', async () => {
    const store = new InMemoryEntityProposalStore();
    await app.register(callbackProposeEntityRoutes, {
      registry: mockRegistry,
      entityProposalStore: store,
      socketManager: mockSocket(),
      approvalIngress: createFailingIngress(),
    });
    await app.ready();

    await app.inject({ method: 'POST', url: '/api/callbacks/propose-entity', payload: validBody });

    // Even if proposal exists in store, its publication must not be 'anchored'
    const all = await store.listPending('user-1');
    for (const p of all) {
      const pub = await store.getPublication(p.proposalId);
      assert.notEqual(pub?.state, 'anchored', 'proposal must NOT be anchored after ingress failure');
    }
  });

  it('retry after ingress failure succeeds with no duplicate card (P1-1)', async () => {
    const store = new InMemoryEntityProposalStore();
    let callCount = 0;
    const ingress = {
      publish: async (draft, s) => {
        callCount++;
        if (callCount === 1) throw new Error('simulated first-call failure');
        return createSucceedingIngress().publish(draft, s);
      },
    };
    await app.register(callbackProposeEntityRoutes, {
      registry: mockRegistry,
      entityProposalStore: store,
      socketManager: mockSocket(),
      approvalIngress: ingress,
    });
    await app.ready();

    // First call fails
    const r1 = await app.inject({ method: 'POST', url: '/api/callbacks/propose-entity', payload: validBody });
    assert.ok(r1.statusCode >= 500, 'first call must fail');

    // Second call succeeds
    const r2 = await app.inject({ method: 'POST', url: '/api/callbacks/propose-entity', payload: validBody });
    assert.equal(r2.statusCode, 200, 'retry must succeed');
    assert.equal(r2.json().status, 'pending');
  });

  it('without approvalIngress → create fails, no legacy socket emit (P1-2)', async () => {
    const store = new InMemoryEntityProposalStore();
    const emitted = [];
    const spySocket = {
      emitToUser: (uid, evt, data) => emitted.push({ uid, evt, data }),
    };
    await app.register(callbackProposeEntityRoutes, {
      registry: mockRegistry,
      entityProposalStore: store,
      socketManager: spySocket,
      // approvalIngress intentionally omitted
    });
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/callbacks/propose-entity', payload: validBody });

    // Must NOT return 200 with legacy socket emit
    const legacyEmits = emitted.filter((e) => e.evt === 'proposal_created');
    assert.equal(legacyEmits.length, 0, 'must NOT emit legacy proposal_created when ingress is absent');
    assert.ok(res.statusCode >= 400, `Expected error status but got ${res.statusCode}`);
  });
});

// ── F221: Taste Proposal Ingress Failure ────────────────────────────────────

describe('P1-1/P1-2: F221 taste proposal ingress failure', () => {
  let InMemoryTasteProposalStore;
  let callbackProposeTasteRoutes;
  let app;

  beforeEach(async () => {
    ({ InMemoryTasteProposalStore } = await import('../../dist/domains/taste/stores/InMemoryTasteProposalStore.js'));
    ({ callbackProposeTasteRoutes } = await import('../../dist/routes/callback-propose-taste-routes.js'));
    app = Fastify();

    app.addHook('preHandler', (request, _reply, done) => {
      request.callbackAuth = {
        invocationId: 'inv-test-2',
        callbackToken: 'tok-test',
        catId: 'opus',
        threadId: 'thread-taste',
        userId: 'user-1',
        clientMessageIds: new Set(),
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      };
      done();
    });
  });

  afterEach(() => app?.close());

  const mockRegistry = { verify: () => ({ ok: false, reason: 'not_reached' }), isLatest: async () => true };
  const mockSocket = () => ({ emitToUser: () => {} });

  const validBody = {
    scene: 'operator said "太客服了" during code review',
    quote: '太客服了，我要的是活人感',
    tags: ['authentic-expression'],
    dimension: 'authentic-expression',
    privacy: 'public',
    clientRequestId: 'taste-ingress-failure',
  };

  it('returns non-2xx when ingress.publish throws (P1-1)', async () => {
    const store = new InMemoryTasteProposalStore();
    await app.register(callbackProposeTasteRoutes, {
      registry: mockRegistry,
      tasteProposalStore: store,
      socketManager: mockSocket(),
      approvalIngress: createFailingIngress(),
    });
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/callbacks/propose-taste', payload: validBody });
    assert.ok(res.statusCode >= 500, `Expected 5xx but got ${res.statusCode}: ingress failure must propagate`);
  });

  it('dedup reservation released after ingress failure — retry creates fresh (P1-1)', async () => {
    const store = new InMemoryTasteProposalStore();
    let callCount = 0;
    const ingress = {
      publish: async (draft, s) => {
        callCount++;
        if (callCount === 1) throw new Error('simulated first-call failure');
        return createSucceedingIngress().publish(draft, s);
      },
    };
    await app.register(callbackProposeTasteRoutes, {
      registry: mockRegistry,
      tasteProposalStore: store,
      socketManager: mockSocket(),
      approvalIngress: ingress,
    });
    await app.ready();

    const bodyWithDedup = { ...validBody, clientRequestId: 'taste-dedup-test' };

    // First call fails
    const r1 = await app.inject({ method: 'POST', url: '/api/callbacks/propose-taste', payload: bodyWithDedup });
    assert.ok(r1.statusCode >= 500, 'first call must fail');

    // Second call must succeed (dedup released, fresh creation)
    const r2 = await app.inject({ method: 'POST', url: '/api/callbacks/propose-taste', payload: bodyWithDedup });
    assert.equal(r2.statusCode, 200, 'retry must succeed after dedup release');
    assert.equal(r2.json().status, 'pending');
  });

  it('concurrent dedup loser stays retryable until the winner is anchored', async () => {
    class ConcurrentRaceStore extends InMemoryTasteProposalStore {
      getDedupProposalId() {
        // Force both requests through reserveDedup so this covers the
        // post-reservation loser branch rather than the cached fast path.
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
        return createSucceedingIngress().publish(draft, publicationStore);
      },
    };
    await app.register(callbackProposeTasteRoutes, {
      registry: mockRegistry,
      tasteProposalStore: store,
      socketManager: mockSocket(),
      approvalIngress: ingress,
    });
    await app.ready();

    const payload = { ...validBody, clientRequestId: 'taste-concurrent-staged' };
    const winnerPromise = app.inject({ method: 'POST', url: '/api/callbacks/propose-taste', payload });
    await started;

    const loser = await app.inject({ method: 'POST', url: '/api/callbacks/propose-taste', payload });
    assert.equal(loser.statusCode, 503, 'staged winner must not be reported as a successful dedup hit');
    assert.equal(loser.json().status, 'retryable');
    assert.equal(loser.headers['retry-after'], '1');

    releasePublish();
    const winner = await winnerPromise;
    assert.equal(winner.statusCode, 200);

    const anchoredRetry = await app.inject({ method: 'POST', url: '/api/callbacks/propose-taste', payload });
    assert.equal(anchoredRetry.statusCode, 200, 'anchored winner may be returned as deduped success');
    assert.equal(anchoredRetry.json().deduped, true);
    assert.equal(anchoredRetry.json().proposalId, winner.json().proposalId);
  });

  it('without approvalIngress → create fails, no legacy socket emit (P1-2)', async () => {
    const store = new InMemoryTasteProposalStore();
    const emitted = [];
    const spySocket = {
      emitToUser: (uid, evt, data) => emitted.push({ uid, evt, data }),
    };
    await app.register(callbackProposeTasteRoutes, {
      registry: mockRegistry,
      tasteProposalStore: store,
      socketManager: spySocket,
      // approvalIngress intentionally omitted
    });
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/callbacks/propose-taste', payload: validBody });

    const legacyEmits = emitted.filter((e) => e.evt === 'taste_proposal_created' || e.evt === 'proposal_created');
    assert.equal(legacyEmits.length, 0, 'must NOT emit legacy events when ingress is absent');
    assert.ok(res.statusCode >= 400, `Expected error status but got ${res.statusCode}`);
  });
});
