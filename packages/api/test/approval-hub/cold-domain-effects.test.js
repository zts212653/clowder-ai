import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { F193ApprovalAdapter } from '../../dist/domains/approval-hub/adapters/F193ApprovalAdapter.js';
import { F260ApprovalAdapter } from '../../dist/domains/approval-hub/adapters/F260ApprovalAdapter.js';
import { InMemoryDispatchProposalStore } from '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js';
import { InMemoryEntityProposalStore } from '../../dist/domains/approval-hub/stores/ports/IEntityProposalStore.js';
import { EntityRegistryStore } from '../../dist/domains/memory/EntityRegistry.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import {
  buildEntityRecord,
  registerEntityProposalDecisionRoutes,
} from '../../dist/routes/entity-proposal-decision-routes.js';
import { anchorApproval, createTestApprovalRegistry } from './helpers.js';

it('F193 cold history proves delivery only after the durable recordDelivery checkpoint', async () => {
  const store = new InMemoryDispatchProposalStore();
  await store.create({
    proposalId: 'dispatch',
    sourceThreadId: 'source',
    targetThreadId: 'target',
    senderCatId: 'opus',
    ownerUserId: 'owner',
    content: 'Deliver',
    targetCats: ['sonnet'],
    createdAt: 1000,
  });
  await anchorApproval(store, {
    proposalId: 'dispatch',
    sourceFeatureId: 'F193',
    ownerUserId: 'owner',
    requesterCatId: 'opus',
    threadId: 'source',
    createdAt: 1000,
  });
  await store.approve('dispatch', 'owner', 'strict');
  const registry = await createTestApprovalRegistry([new F193ApprovalAdapter(store)]);
  const [unknown] = await registry.listSettled('owner');
  assert.equal(unknown.materialization.state, 'outcome_unknown');
  await store.recordDelivery('dispatch', 'delivery-message');
  const [delivered] = await registry.listSettled('owner');
  assert.equal(delivered.materialization.state, 'succeeded');
  assert.match(delivered.materialization.effectProofRef, /delivery-message/);
  assert.deepEqual(await registry.listSettled('foreign'), []);
});

it('F260 cold history reads the exact committed revision, not approval or copied proposal provenance', async () => {
  const db = new Database(':memory:');
  applyMigrations(db);
  const entities = new EntityRegistryStore(db);
  const store = new InMemoryEntityProposalStore();
  const proposal = store.create({
    proposalId: 'entity-proposal',
    ownerUserId: 'owner',
    sourceCatId: 'opus',
    sourceThreadId: 'source',
    entityId: 'concept:result',
    entityType: 'concept',
    canonicalName: 'Result',
    aliases: [],
    stance: 'endorsed',
    visibilityScope: 'workspace',
    rationale: 'Original reason',
    provenance: [],
  });
  await anchorApproval(store, {
    proposalId: proposal.proposalId,
    sourceFeatureId: 'F260',
    ownerUserId: 'owner',
    requesterCatId: 'opus',
    threadId: 'source',
    createdAt: proposal.createdAt,
  });
  const adapter = new F260ApprovalAdapter(store, undefined, (p) =>
    entities.proposalEffectProof(p.entityId, p.proposalId, p.ownerUserId),
  );
  const registry = await createTestApprovalRegistry([adapter]);
  const incoming = buildEntityRecord(proposal, 'owner');
  try {
    store.markApproved(proposal.proposalId, 'owner');
    assert.equal(
      (await registry.listSettled('owner'))[0].materialization.state,
      'outcome_unknown',
      'markApproved-before-upsert crash window',
    );
    entities.upsert([{ ...incoming, provenance: [{ source: 'proposal', anchor: proposal.proposalId }] }], {
      source: 'system',
      actorId: 'owner',
      proposalId: proposal.proposalId,
    });
    assert.equal(
      (await registry.listSettled('owner'))[0].materialization.state,
      'outcome_unknown',
      'untrusted entity provenance is insufficient',
    );
    // Remove only the test projection; the untrusted immutable revision remains and still cannot prove this proposal.
    db.prepare('DELETE FROM entity_aliases WHERE entity_id = ?').run(proposal.entityId);
    db.prepare('DELETE FROM entity_registry WHERE entity_id = ?').run(proposal.entityId);
    store.revertToPending(proposal.proposalId);
    const app = Fastify();
    registerEntityProposalDecisionRoutes(app, {
      store,
      upsertEntities: (rows, context) => entities.upsert(rows, context),
      inspectEntityConflict: async () => null,
      resolveEntityConflict: async () => {},
      socketManager: { emitToUser() {} },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/entity-proposals/${proposal.proposalId}/approve`,
        headers: { 'x-cat-cafe-user': 'owner' },
      });
      assert.equal(response.statusCode, 200, response.body);
    } finally {
      await app.close();
    }
    const [written] = await registry.listSettled('owner');
    assert.equal(written.materialization.state, 'succeeded');
    assert.match(written.materialization.effectProofRef, /entity-revision/);
    assert.equal(entities.proposalEffectProof(proposal.entityId, proposal.proposalId, 'foreign'), null);
    assert.equal(entities.proposalEffectProof('concept:foreign', proposal.proposalId, 'owner'), null);
    assert.equal(entities.proposalEffectProof(proposal.entityId, 'other-proposal', 'owner'), null);
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT revision_id FROM entity_revision_events WHERE entity_id=? AND source='proposal-approval' AND actor_id=? AND proposal_id=? ORDER BY revision_id DESC LIMIT 1",
      )
      .all(proposal.entityId, 'owner', proposal.proposalId);
    assert.ok(
      plan.some((row) => row.detail.includes('idx_entity_revision_events_proposal_effect')),
      JSON.stringify(plan),
    );
  } finally {
    db.close();
  }
});
