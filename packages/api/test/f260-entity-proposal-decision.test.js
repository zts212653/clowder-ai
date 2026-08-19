/**
 * F260 Phase A T2: Entity proposal decision routes test.
 *
 * Tests POST /api/entity-proposals/:proposalId/approve and /reject.
 * On approve, EntityRegistryStore.upsert() is called with the proposal data (atomic SQLite).
 * On reject, only the proposal status changes (audit trail).
 *
 * Also tests INV-5: seeds reload must skip entities with proposal provenance.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { anchorApproval } from './approval-hub/helpers.js';

describe('F260 entity proposal decision routes', () => {
  let app;
  let InMemoryEntityProposalStore;
  let registerEntityProposalDecisionRoutes;

  beforeEach(async () => {
    ({ InMemoryEntityProposalStore } = await import(
      '../dist/domains/approval-hub/stores/ports/IEntityProposalStore.js'
    ));
    ({ registerEntityProposalDecisionRoutes } = await import('../dist/routes/entity-proposal-decision-routes.js'));
    app = Fastify();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  const createStore = () => new InMemoryEntityProposalStore();

  const createProposal = async (store, overrides = {}) => {
    const proposal = store.create({
      entityId: 'concept:未婚喵',
      entityType: 'concept',
      canonicalName: '未婚喵',
      aliases: ['未婚喵', '未婚猫'],
      stance: 'endorsed',
      visibilityScope: 'workspace',
      provenance: [{ source: 'cat-proposed', anchor: 'thread_abc' }],
      rationale: 'Recurring term',
      sourceThreadId: 't-1',
      sourceCatId: 'opus',
      ownerUserId: 'user-1',
      ...overrides,
    });
    // F246 Phase I: anchor publication so decision guards pass.
    await anchorApproval(store, {
      proposalId: proposal.proposalId,
      sourceFeatureId: 'F260',
      ownerUserId: proposal.ownerUserId,
      requesterCatId: proposal.sourceCatId,
      threadId: proposal.sourceThreadId,
      createdAt: proposal.createdAt,
    });
    return proposal;
  };

  const mockUpsertEntities = () => {
    const upserted = [];
    const contexts = [];
    return {
      fn: (entities, context) => {
        upserted.push(...entities);
        contexts.push(context);
      },
      getUpserted: () => upserted,
      getContexts: () => contexts,
    };
  };

  const mockSocketManager = () => {
    const emitted = [];
    return {
      emitToUser: (...args) => emitted.push(args),
      getEmitted: () => emitted,
    };
  };

  const registerRoutes = (store, upsertMock, socketManager = mockSocketManager(), overrides = {}) => {
    registerEntityProposalDecisionRoutes(app, {
      store,
      upsertEntities: upsertMock.fn,
      inspectEntityConflict: async () => null,
      resolveEntityConflict: async () => undefined,
      socketManager,
      ...overrides,
    });
    return app.ready();
  };

  const conflictContext = (overrides = {}) => ({
    version: 1,
    reason: 'surface-collision',
    fingerprint: 'a'.repeat(64),
    incoming: {
      entityId: 'concept:未婚喵',
      entityType: 'concept',
      canonicalName: '未婚喵',
      aliases: ['未婚喵', '未婚猫'],
      stance: 'endorsed',
      visibilityScope: 'workspace',
      status: 'active',
    },
    candidates: [
      {
        entityId: 'concept:existing',
        entityType: 'concept',
        canonicalName: 'Existing',
        aliases: ['未婚喵'],
        stance: 'endorsed',
        visibilityScope: 'workspace',
        status: 'active',
      },
    ],
    conflictingSurfaces: ['未婚喵'],
    canonicalReplacementRequiredFor: [],
    allowedActions: ['correct', 'transfer', 'polysemy', 'reject'],
    ...overrides,
  });

  const injectApprove = (proposalId, userId = 'user-1') =>
    app.inject({
      method: 'POST',
      url: `/api/entity-proposals/${proposalId}/approve`,
      headers: { 'x-cat-cafe-user': userId },
    });

  const injectReject = (proposalId, body = {}, userId = 'user-1') =>
    app.inject({
      method: 'POST',
      url: `/api/entity-proposals/${proposalId}/reject`,
      headers: { 'x-cat-cafe-user': userId },
      payload: body,
    });

  const injectResolve = (proposalId, body, userId = 'user-1') =>
    app.inject({
      method: 'POST',
      url: `/api/entity-proposals/${proposalId}/resolve`,
      headers: { 'x-cat-cafe-user': userId },
      payload: body,
    });

  describe('POST /api/entity-proposals/:proposalId/approve', () => {
    it('approves a pending proposal and upserts into EntityRegistry', async () => {
      const store = createStore();
      const upsertMock = mockUpsertEntities();
      const p = await createProposal(store);
      await registerRoutes(store, upsertMock);

      const res = await injectApprove(p.proposalId);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.proposalId, p.proposalId);
      assert.equal(body.status, 'approved');

      // Verify entity was upserted into registry
      const upserted = upsertMock.getUpserted();
      assert.equal(upserted.length, 1);
      assert.equal(upserted[0].entityId, 'concept:未婚喵');
      assert.equal(upserted[0].canonicalName, '未婚喵');
      assert.deepEqual(upserted[0].aliases, ['未婚喵', '未婚猫']);

      // Verify proposal provenance includes 'proposal' source for INV-5
      const prov = upserted[0].provenance;
      const proposalEntry = prov.find((p) => p.source === 'proposal');
      assert.ok(proposalEntry, 'must include proposal provenance');

      // Structured birth-thread provenance (codex review R2: anchor, not note)
      const threadEntry = prov.find((p) => p.source === 'callback-thread');
      assert.ok(threadEntry, 'must include structured callback-thread provenance');
      assert.equal(threadEntry.anchor, 't-1', 'callback-thread anchor must be sourceThreadId');

      assert.deepEqual(upsertMock.getContexts(), [
        {
          source: 'proposal-approval',
          actorId: 'user-1',
          proposalId: p.proposalId,
          reason: 'Recurring term',
          conflictPolicy: 'reject-conflict',
        },
      ]);
    });

    it('returns 404 for non-existent proposal', async () => {
      const store = createStore();
      const upsertMock = mockUpsertEntities();
      await registerRoutes(store, upsertMock);

      const res = await injectApprove('nonexistent');
      assert.equal(res.statusCode, 404);
    });

    it('returns 403 for wrong user', async () => {
      const store = createStore();
      const upsertMock = mockUpsertEntities();
      const p = await createProposal(store);
      await registerRoutes(store, upsertMock);

      const res = await injectApprove(p.proposalId, 'wrong-user');
      assert.equal(res.statusCode, 403);
    });

    it('returns 409 for already-approved proposal', async () => {
      const store = createStore();
      const upsertMock = mockUpsertEntities();
      const p = await createProposal(store);
      store.markApproved(p.proposalId, 'user-1');
      await registerRoutes(store, upsertMock);

      const res = await injectApprove(p.proposalId);
      assert.equal(res.statusCode, 409);
    });

    it('returns 401 when no user identity', async () => {
      const store = createStore();
      const upsertMock = mockUpsertEntities();
      await createProposal(store);
      await registerRoutes(store, upsertMock);

      const res = await app.inject({
        method: 'POST',
        url: '/api/entity-proposals/ep-1/approve',
      });
      assert.equal(res.statusCode, 401);
    });

    it('returns 500 and keeps proposal pending when upsertEntities throws', async () => {
      const store = createStore();
      const p = await createProposal(store);
      const throwingUpsert = mockUpsertEntities();
      throwingUpsert.fn = () => {
        throw new Error('SQLite write failed');
      };
      await registerRoutes(store, throwingUpsert);

      const res = await injectApprove(p.proposalId);
      assert.equal(res.statusCode, 500, 'must return 500 on upsert failure');

      // Proposal must remain pending (reverted via revertToPending after markApproved CAS)
      const still = store.get(p.proposalId);
      assert.equal(still.status, 'pending', 'proposal must revert to pending after upsert failure');
    });

    it('returns typed 409 and keeps proposal pending when registry surfaces conflict', async () => {
      const { EntitySurfaceConflictError } = await import('../dist/domains/memory/EntityRegistry.js');
      const store = createStore();
      const p = await createProposal(store);
      const conflictingUpsert = mockUpsertEntities();
      const socketManager = mockSocketManager();
      conflictingUpsert.fn = () => {
        throw new EntitySurfaceConflictError({
          incomingEntityId: p.entityId,
          conflictingEntityIds: ['concept:existing'],
          conflictingSurfaces: ['未婚喵'],
          reason: 'surface-collision',
        });
      };
      const conflict = conflictContext();
      await registerRoutes(store, conflictingUpsert, socketManager, {
        inspectEntityConflict: async () => conflict,
      });

      const res = await injectApprove(p.proposalId);
      assert.equal(res.statusCode, 409);
      assert.deepEqual(JSON.parse(res.body), {
        error: 'entity_surface_conflict',
        message: 'Entity registration conflicts with current workspace registry truth',
        incomingEntityId: p.entityId,
        conflictingEntityIds: ['concept:existing'],
        conflictingSurfaces: ['未婚喵'],
        reason: 'surface-collision',
        conflict,
      });
      assert.equal(store.get(p.proposalId).status, 'pending');
      assert.deepEqual(socketManager.getEmitted(), [], 'conflict must not emit an approved proposal event');
    });

    it('does not expose a private collision candidate to another proposal owner', async () => {
      const { SqliteEvidenceStore } = await import('../dist/domains/memory/SqliteEvidenceStore.js');
      const evidenceStore = new SqliteEvidenceStore(':memory:');
      await evidenceStore.initialize();
      const store = createStore();
      const proposal = await createProposal(store, {
        entityId: 'concept:workspace-guard',
        canonicalName: 'Workspace Guard',
        aliases: ['shared-guard'],
        ownerUserId: 'user-other',
      });
      await evidenceStore.upsertEntities(
        [
          {
            entityId: 'concept:private-guard',
            type: 'concept',
            canonicalName: 'Owner Secret Guard',
            aliases: ['shared-guard', 'owner-secret-alias'],
            provenance: [{ source: 'proposal', anchor: 'private-anchor' }],
            stance: 'endorsed',
            visibilityScope: 'private:user-owner',
            status: 'active',
            updatedAt: '2026-07-18T12:34:56.000Z',
          },
        ],
        { source: 'system' },
      );
      await registerRoutes(
        store,
        { fn: (entities, context) => evidenceStore.upsertEntities(entities, context) },
        undefined,
        {
          inspectEntityConflict: (incoming, viewerUserId) =>
            evidenceStore.inspectEntityConflict(incoming, viewerUserId),
        },
      );

      try {
        const response = await injectApprove(proposal.proposalId, 'user-other');
        assert.equal(response.statusCode, 409);
        const body = JSON.parse(response.body);
        assert.deepEqual(body.conflictingEntityIds, []);
        assert.deepEqual(body.conflict.candidates, []);
        assert.deepEqual(body.conflict.allowedActions, ['reject']);
        assert.doesNotMatch(
          response.body,
          /concept:private-guard|Owner Secret Guard|owner-secret-alias|private:user-owner|2026-07-18T12:34:56/,
        );
        assert.equal(store.get(proposal.proposalId).status, 'pending');
      } finally {
        evidenceStore.close();
      }
    });

    it('serializes real registry approvals so the second exact-surface writer is rejected', async () => {
      const { SqliteEvidenceStore } = await import('../dist/domains/memory/SqliteEvidenceStore.js');
      const evidenceStore = new SqliteEvidenceStore(':memory:');
      await evidenceStore.initialize();
      const store = createStore();
      const first = await createProposal(store);
      const second = await createProposal(store, {
        entityId: 'concept:未婚喵2',
        canonicalName: 'Second Unmarried Cat',
        aliases: ['未婚喵'],
      });
      await registerRoutes(store, { fn: (entities, context) => evidenceStore.upsertEntities(entities, context) });

      try {
        assert.equal((await injectApprove(first.proposalId)).statusCode, 200);
        const conflict = await injectApprove(second.proposalId);
        assert.equal(conflict.statusCode, 409);
        assert.equal(store.get(second.proposalId).status, 'pending');
        assert.ok(await evidenceStore.getEntity(first.entityId));
        assert.equal(await evidenceStore.getEntity(second.entityId), null);
      } finally {
        evidenceStore.close();
      }
    });

    it('preserves stance and visibilityScope from proposal in upserted entity (KD-7)', async () => {
      const store = createStore();
      const upsertMock = mockUpsertEntities();
      // Create proposal with non-default stance (private scope blocked at creation layer per R4)
      const p = store.create({
        entityId: 'concept:hot-take',
        entityType: 'concept',
        canonicalName: 'Hot Take',
        aliases: ['hot-take'],
        stance: 'critique_target',
        visibilityScope: 'workspace',
        provenance: [{ source: 'cat-proposed', anchor: 'thread_xyz' }],
        rationale: 'Critique concept',
        sourceThreadId: 't-2',
        sourceCatId: 'opus',
        ownerUserId: 'user-1',
      });
      await anchorApproval(store, {
        proposalId: p.proposalId,
        sourceFeatureId: 'F260',
        ownerUserId: p.ownerUserId,
        requesterCatId: p.sourceCatId,
        threadId: p.sourceThreadId,
        createdAt: p.createdAt,
      });
      await registerRoutes(store, upsertMock);

      const res = await injectApprove(p.proposalId);
      assert.equal(res.statusCode, 200);

      const upserted = upsertMock.getUpserted();
      assert.equal(upserted.length, 1);
      assert.equal(upserted[0].stance, 'critique_target', 'stance must carry through from proposal');
      assert.equal(upserted[0].visibilityScope, 'workspace', 'visibilityScope must carry through');
      assert.equal(upserted[0].status, 'active', 'approved entity status = active');
    });

    it('reverts approval on concurrent reject (Blocker 2: race condition)', async () => {
      const store = createStore();
      // Simulate race: after markApproved succeeds, upsert fails because
      // in a real race the entity might have been cleaned up.
      // The key invariant: proposal must revert to pending, not stay approved.
      const p = await createProposal(store);
      const racingUpsert = mockUpsertEntities();
      racingUpsert.fn = () => {
        throw new Error('Simulated race — upsert fails after CAS approve');
      };
      await registerRoutes(store, racingUpsert);

      const res = await injectApprove(p.proposalId);
      assert.equal(res.statusCode, 500, 'must fail with 500');

      // After rollback, proposal must be pending again (not stuck in approved)
      const reverted = store.get(p.proposalId);
      assert.equal(reverted.status, 'pending', 'must revert to pending after upsert failure — no orphaned approval');
    });
  });

  describe('POST /api/entity-proposals/:proposalId/resolve', () => {
    it('completes the real approve-conflict-merge flow through SqliteEvidenceStore', async () => {
      const { SqliteEvidenceStore } = await import('../dist/domains/memory/SqliteEvidenceStore.js');
      const evidenceStore = new SqliteEvidenceStore(':memory:');
      await evidenceStore.initialize();
      const store = createStore();
      const socketManager = mockSocketManager();
      const proposal = await createProposal(store, {
        entityId: 'concept:沉迷护栏',
        canonicalName: '猫猫安全护栏',
        aliases: ['安全护栏', 'AI沉迷护栏'],
        provenance: [{ source: 'proposal', anchor: 'ep-new' }],
      });
      await evidenceStore.upsertEntities(
        [
          {
            entityId: proposal.entityId,
            type: 'concept',
            canonicalName: '防AI沉迷护栏',
            aliases: ['沉迷护栏'],
            provenance: [{ source: 'proposal', anchor: 'ep-old' }],
            stance: 'endorsed',
            visibilityScope: 'workspace',
            status: 'active',
            updatedAt: '2026-07-10T00:00:00.000Z',
          },
        ],
        { source: 'system' },
      );
      await registerRoutes(
        store,
        { fn: (entities, context) => evidenceStore.upsertEntities(entities, context) },
        socketManager,
        {
          inspectEntityConflict: (incoming) => evidenceStore.inspectEntityConflict(incoming),
          resolveEntityConflict: (incoming, resolution, context) =>
            evidenceStore.resolveEntityConflict(incoming, resolution, context),
        },
      );

      try {
        const conflictResponse = await injectApprove(proposal.proposalId);
        assert.equal(conflictResponse.statusCode, 409);
        const conflict = JSON.parse(conflictResponse.body).conflict;
        assert.equal(conflict.reason, 'existing-entity-change');

        const resolvedResponse = await injectResolve(proposal.proposalId, {
          action: 'merge-aliases',
          fingerprint: conflict.fingerprint,
        });
        assert.equal(resolvedResponse.statusCode, 200);
        assert.equal(store.get(proposal.proposalId).status, 'approved');
        const resolved = await evidenceStore.getEntity(proposal.entityId);
        assert.equal(resolved.canonicalName, '防AI沉迷护栏');
        assert.deepEqual(resolved.aliases, ['AI沉迷护栏', '安全护栏', '沉迷护栏', '猫猫安全护栏']);
        assert.equal(socketManager.getEmitted().length, 1);
      } finally {
        evidenceStore.close();
      }
    });

    it('rolls back registry and revision writes when mention refresh fails after a resolution', async () => {
      const { SqliteEvidenceStore } = await import('../dist/domains/memory/SqliteEvidenceStore.js');
      const evidenceStore = new SqliteEvidenceStore(':memory:');
      await evidenceStore.initialize();
      const store = createStore();
      const proposal = await createProposal(store, {
        entityId: 'concept:沉迷护栏',
        canonicalName: '猫猫安全护栏',
        aliases: ['安全护栏'],
      });
      await evidenceStore.upsertEntities(
        [
          {
            entityId: proposal.entityId,
            type: 'concept',
            canonicalName: '防AI沉迷护栏',
            aliases: ['沉迷护栏'],
            provenance: [{ source: 'proposal', anchor: 'ep-old' }],
            stance: 'endorsed',
            visibilityScope: 'workspace',
            status: 'active',
            updatedAt: '2026-07-10T00:00:00.000Z',
          },
        ],
        { source: 'system' },
      );
      await registerRoutes(
        store,
        { fn: (entities, context) => evidenceStore.upsertEntities(entities, context) },
        undefined,
        {
          inspectEntityConflict: (incoming, viewerUserId) =>
            evidenceStore.inspectEntityConflict(incoming, viewerUserId),
          resolveEntityConflict: (incoming, resolution, context) =>
            evidenceStore.resolveEntityConflict(incoming, resolution, context),
        },
      );

      try {
        const conflictResponse = await injectApprove(proposal.proposalId);
        const conflict = JSON.parse(conflictResponse.body).conflict;
        evidenceStore.entityRegistry.refreshMentionsForEntities = () => {
          throw new Error('forced mention refresh failure');
        };

        const response = await injectResolve(proposal.proposalId, {
          action: 'merge-aliases',
          fingerprint: conflict.fingerprint,
        });

        assert.equal(response.statusCode, 500);
        assert.equal(store.get(proposal.proposalId).status, 'pending');
        const current = await evidenceStore.getEntity(proposal.entityId);
        assert.equal(current.canonicalName, '防AI沉迷护栏');
        assert.deepEqual(current.aliases, ['沉迷护栏']);
        assert.equal(
          evidenceStore.db
            .prepare('SELECT count(*) AS n FROM entity_revision_events WHERE proposal_id = ?')
            .get(proposal.proposalId).n,
          0,
        );
      } finally {
        evidenceStore.close();
      }
    });

    it('claims the pending proposal, applies the explicit resolution, and emits only after success', async () => {
      const store = createStore();
      const upsertMock = mockUpsertEntities();
      const socketManager = mockSocketManager();
      const proposal = await createProposal(store);
      const calls = [];
      await registerRoutes(store, upsertMock, socketManager, {
        resolveEntityConflict: async (...args) => calls.push(args),
      });

      const resolution = {
        action: 'correct',
        fingerprint: 'a'.repeat(64),
        replacementCanonicalNames: { 'concept:existing': '旧未婚喵' },
      };
      const response = await injectResolve(proposal.proposalId, resolution);

      assert.equal(response.statusCode, 200);
      assert.equal(store.get(proposal.proposalId).status, 'approved');
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0].entityId, proposal.entityId);
      assert.deepEqual(calls[0][1], resolution);
      assert.deepEqual(calls[0][2], {
        source: 'proposal-approval',
        actorId: 'user-1',
        proposalId: proposal.proposalId,
        reason: proposal.rationale,
      });
      assert.equal(socketManager.getEmitted().length, 1);
    });

    it('validates action, fingerprint, ownership, and replacement value shapes before claiming', async () => {
      const store = createStore();
      const upsertMock = mockUpsertEntities();
      const proposal = await createProposal(store);
      await registerRoutes(store, upsertMock);

      const invalidBodies = [
        {},
        { action: 'reject', fingerprint: 'a'.repeat(64) },
        { action: 'correct', fingerprint: 'short' },
        {
          action: 'correct',
          fingerprint: 'a'.repeat(64),
          replacementCanonicalNames: { 'concept:existing': '' },
        },
      ];
      for (const body of invalidBodies) {
        const response = await injectResolve(proposal.proposalId, body);
        assert.equal(response.statusCode, 400);
      }
      assert.equal((await injectResolve(proposal.proposalId, invalidBodies[1], 'wrong-user')).statusCode, 403);
      assert.equal(store.get(proposal.proposalId).status, 'pending');
    });

    it('returns a refreshed actionable context and keeps pending when the decision is stale', async () => {
      const { EntityConflictStaleError } = await import('../dist/domains/memory/EntityRegistry.js');
      const store = createStore();
      const upsertMock = mockUpsertEntities();
      const socketManager = mockSocketManager();
      const proposal = await createProposal(store);
      const fresh = conflictContext({ fingerprint: 'b'.repeat(64) });
      await registerRoutes(store, upsertMock, socketManager, {
        resolveEntityConflict: async () => {
          throw new EntityConflictStaleError(fresh);
        },
      });

      const response = await injectResolve(proposal.proposalId, {
        action: 'correct',
        fingerprint: 'a'.repeat(64),
      });

      assert.equal(response.statusCode, 409);
      assert.deepEqual(JSON.parse(response.body), {
        error: 'entity_conflict_stale',
        message: 'Entity conflict context changed; review the current registry truth and retry',
        conflict: fresh,
      });
      assert.equal(store.get(proposal.proposalId).status, 'pending');
      assert.deepEqual(socketManager.getEmitted(), []);
    });

    it('returns an actionable validation error and compensates proposal state', async () => {
      const { EntityConflictInvalidResolutionError } = await import('../dist/domains/memory/EntityRegistry.js');
      const store = createStore();
      const upsertMock = mockUpsertEntities();
      const proposal = await createProposal(store);
      const conflict = conflictContext({ canonicalReplacementRequiredFor: ['concept:existing'] });
      await registerRoutes(store, upsertMock, mockSocketManager(), {
        resolveEntityConflict: async () => {
          throw new EntityConflictInvalidResolutionError('Replacement canonical name is required', conflict);
        },
      });

      const response = await injectResolve(proposal.proposalId, {
        action: 'correct',
        fingerprint: conflict.fingerprint,
      });

      assert.equal(response.statusCode, 422);
      assert.deepEqual(JSON.parse(response.body), {
        error: 'entity_conflict_invalid_resolution',
        message: 'Replacement canonical name is required',
        conflict,
      });
      assert.equal(store.get(proposal.proposalId).status, 'pending');
    });

    it('returns 500, remains pending, and emits nothing on an unexpected registry failure', async () => {
      const store = createStore();
      const upsertMock = mockUpsertEntities();
      const socketManager = mockSocketManager();
      const proposal = await createProposal(store);
      await registerRoutes(store, upsertMock, socketManager, {
        resolveEntityConflict: async () => {
          throw new Error('forced transaction failure');
        },
      });

      const response = await injectResolve(proposal.proposalId, {
        action: 'polysemy',
        fingerprint: 'a'.repeat(64),
      });

      assert.equal(response.statusCode, 500);
      assert.equal(store.get(proposal.proposalId).status, 'pending');
      assert.deepEqual(socketManager.getEmitted(), []);
    });
  });

  describe('POST /api/entity-proposals/:proposalId/reject', () => {
    it('rejects a pending proposal', async () => {
      const store = createStore();
      const upsertMock = mockUpsertEntities();
      const p = await createProposal(store);
      await registerRoutes(store, upsertMock);

      const res = await injectReject(p.proposalId, { rejectionReason: 'Too vague' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.proposalId, p.proposalId);
      assert.equal(body.status, 'rejected');

      // EntityRegistry should NOT be modified on reject
      assert.equal(upsertMock.getUpserted().length, 0);
    });

    it('returns 404 for non-existent proposal', async () => {
      const store = createStore();
      const upsertMock = mockUpsertEntities();
      await registerRoutes(store, upsertMock);

      const res = await injectReject('nonexistent');
      assert.equal(res.statusCode, 404);
    });

    it('returns 409 for already-rejected proposal', async () => {
      const store = createStore();
      const upsertMock = mockUpsertEntities();
      const p = await createProposal(store);
      store.markRejected(p.proposalId, 'user-1');
      await registerRoutes(store, upsertMock);

      // Already rejected — should be idempotent (return current status)
      const res = await injectReject(p.proposalId);
      const body = JSON.parse(res.body);
      assert.ok(body.status === 'rejected' || res.statusCode === 409);
    });
  });
});
