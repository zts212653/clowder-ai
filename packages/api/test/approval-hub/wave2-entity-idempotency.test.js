import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

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

// ── R4 P1-1: F260 clientRequestId dedup — no proxy identity ───────────────
//
// R3 used (entityId, sourceCatId) as a proxy retry identity, silently
// swallowing legitimate new proposals with different content. Wave 2 now
// requires an explicit transport identity before publication so a persisted
// card can always be recovered after an uncertain commit acknowledgement.
//
// [宪宪/Claude Opus 4.6🐾]

describe('P1-1 R4: F260 explicit clientRequestId — no proxy retry identity', () => {
  let InMemoryEntityProposalStore;
  let callbackProposeEntityRoutes;
  let app;

  beforeEach(async () => {
    ({ InMemoryEntityProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IEntityProposalStore.js'
    ));
    ({ callbackProposeEntityRoutes } = await import('../../dist/routes/callback-propose-entity-routes.js'));
    app = Fastify();

    app.addHook('preHandler', (request, _reply, done) => {
      request.callbackAuth = {
        invocationId: 'inv-test-r4',
        callbackToken: 'tok-test',
        catId: 'opus',
        threadId: 'thread-r4',
        userId: 'user-r4',
        clientMessageIds: new Set(),
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      };
      done();
    });
  });

  afterEach(() => app?.close());

  const mockRegistry = { verify: () => ({ ok: false, reason: 'not_reached' }) };
  const mockSocket = () => ({ emitToUser: () => {}, broadcastToRoom: () => {} });

  const baseBody = {
    entityId: 'concept:未婚喵',
    entityType: 'concept',
    canonicalName: '未婚喵',
    aliases: ['未婚喵'],
    stance: 'endorsed',
    visibilityScope: 'workspace',
    provenance: [{ source: 'cat-proposed', anchor: 'thread_abc' }],
    rationale: 'First meaning',
  };

  it('rejects a missing clientRequestId before creating an entity proposal', async () => {
    const store = new InMemoryEntityProposalStore();
    await app.register(callbackProposeEntityRoutes, {
      registry: mockRegistry,
      entityProposalStore: store,
      socketManager: mockSocket(),
      approvalIngress: createSucceedingIngress(),
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-entity',
      payload: { ...baseBody, rationale: 'First meaning' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal((await store.listPending('user-r4')).length, 0);
  });

  it('same entityId, same clientRequestId, first staged → retry recovers (not duplicate)', async () => {
    const store = new InMemoryEntityProposalStore();
    let callCount = 0;
    const ingress = {
      publish: async (draft, s) => {
        callCount++;
        if (callCount === 1) {
          // Simulate commitEnvelope failure AFTER card persisted
          // The store's publication remains 'staged'
          const { ApprovalCardCommittedError } = await import('../../dist/domains/approval-hub/ApprovalIngress.js');
          throw new ApprovalCardCommittedError(new Error('commit unavailable'), 'msg-card-1');
        }
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

    // First call — commitEnvelope fails after card persisted
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-entity',
      payload: { ...baseBody, clientRequestId: 'cr-retry-1' },
    });
    assert.ok(r1.statusCode >= 500, 'first call must fail (commit failure)');

    // Verify dedup key is still reserved (ApprovalCardCommittedError = don't release)
    const dedupId = store.getDedupProposalId('user-r4', 'cr-retry-1');
    assert.ok(dedupId, 'dedup key must be preserved after card-committed failure');

    // Verify publication is still staged
    const pub = await store.getPublication(dedupId);
    assert.equal(pub?.state, 'staged', 'publication must still be staged');

    // Second call with same clientRequestId — must recover, not create duplicate
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-entity',
      payload: { ...baseBody, clientRequestId: 'cr-retry-1' },
    });
    assert.equal(r2.statusCode, 200, 'retry must succeed');
    assert.equal(r2.json().recovered, true, 'must be flagged as recovered');
    assert.equal(r2.json().proposalId, dedupId, 'must recover the same proposal');
  });
});
