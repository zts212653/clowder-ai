import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { F139ApprovalAdapter } from '../../dist/domains/approval-hub/adapters/F139ApprovalAdapter.js';
import { fingerprintDynamicTaskDef } from '../../dist/infrastructure/scheduler/ScheduleMutationProposalStore.js';
import { createDecisionFixture, createProposal, OWNER, task } from './schedule-proposal-decision-fixture.js';

describe('approved schedule parameter updates', () => {
  let fixture, original, proposal, delivered;
  beforeEach(async () => {
    delivered = [];
    fixture = await createDecisionFixture({
      deliver: async (input) => {
        delivered.push(input);
        return 'delivered';
      },
    });
    original = task({ trigger: { type: 'interval', ms: 60_000 } });
    fixture.dynamicStore.insert(original);
    fixture.register(original);
    proposal = createProposal({
      proposalId: 'schedule-update',
      mutation: {
        kind: 'update',
        taskId: original.id,
        taskSnapshot: original,
        expectedFingerprint: fingerprintDynamicTaskDef(original),
        params: { ...original.params, message: 'updated reminder' },
      },
    });
    fixture.store.create(proposal);
  });
  afterEach(async () => fixture.close());

  it('requires the owner and anchored publication; rejection leaves the old task running', async () => {
    const unauthenticated = await fixture.app.inject({
      method: 'POST',
      url: `/api/schedule-proposals/${proposal.proposalId}/approve`,
    });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal((await fixture.decide(proposal.proposalId, 'approve')).statusCode, 409);
    fixture.anchor(proposal);
    assert.equal((await fixture.decide(proposal.proposalId, 'reject')).statusCode, 200);
    assert.deepEqual(fixture.dynamicStore.getById(original.id), original);
    await fixture.runner.triggerNow(original.id);
    assert.match(delivered[0].content, /stretch/);
    assert.equal(fixture.store.listAudit(OWNER).length, 0);
  });

  it('updates the same definition once, refreshes live execution, and projects the actual update', async () => {
    fixture.anchor(proposal);
    const adapter = new F139ApprovalAdapter(fixture.store);
    const pending = adapter.listPending(OWNER)[0];
    assert.equal(pending.detail.mutationKind, 'update');
    assert.deepEqual(pending.detail.params, proposal.mutation.params);
    assert.equal((await fixture.decide(proposal.proposalId, 'approve')).statusCode, 200);
    assert.equal((await fixture.decide(proposal.proposalId, 'approve')).statusCode, 409);
    assert.deepEqual(fixture.dynamicStore.getAll(), [{ ...original, params: proposal.mutation.params }]);
    await fixture.runner.triggerNow(original.id);
    assert.match(delivered[0].content, /updated reminder/);
    const approved = fixture.store.getById(proposal.proposalId);
    assert.equal(approved.effectCheckpoint.kind, 'update');
    assert.equal(
      approved.effectCheckpoint.resultingFingerprint,
      fingerprintDynamicTaskDef(fixture.dynamicStore.getById(original.id)),
    );
    assert.equal(fixture.store.listAudit(OWNER).length, 1);
    const settled = adapter.listSettled(OWNER)[0];
    assert.equal(settled.detail.mutationKind, 'update');
    assert.match(settled.summary, /Update schedule/);
    const receipts = await fixture.messageStore.getByThread('thread-owner');
    assert.equal(receipts.length, 1);
    assert.match(receipts[0].content, /定时提案 schedule-update 已批准/);
  });

  it('rejects definition drift before writing params or a checkpoint', async () => {
    fixture.anchor(proposal);
    fixture.db
      .prepare('UPDATE dynamic_task_defs SET params_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...original.params, message: 'newer edit' }), original.id);
    const response = await fixture.decide(proposal.proposalId, 'approve');
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'SCHEDULE_TASK_DRIFT');
    assert.equal(fixture.dynamicStore.getById(original.id).params.message, 'newer edit');
    assert.equal(fixture.store.getById(proposal.proposalId).status, 'pending');
    assert.equal(fixture.store.getById(proposal.proposalId).effectCheckpoint, undefined);
    assert.equal(fixture.store.listAudit(OWNER).length, 0);
  });

  it('recovers a committed effect after refresh failure without duplicating the audit', async () => {
    fixture.anchor(proposal);
    const refresh = fixture.runner.refreshDynamic.bind(fixture.runner);
    fixture.runner.refreshDynamic = () => {
      throw new Error('injected refresh interruption');
    };
    assert.equal((await fixture.decide(proposal.proposalId, 'approve')).statusCode, 500);
    assert.equal(fixture.store.getById(proposal.proposalId).status, 'applying');
    assert.equal(fixture.dynamicStore.getById(original.id).params.message, 'updated reminder');
    fixture.runner.refreshDynamic = refresh;
    assert.equal((await fixture.decide(proposal.proposalId, 'approve')).statusCode, 200);
    await fixture.runner.triggerNow(original.id);
    assert.match(delivered[0].content, /updated reminder/);
    assert.equal(fixture.store.listAudit(OWNER).length, 1);
  });

  it('settles a committed update without replaying it over a later approved edit', async () => {
    fixture.anchor(proposal);
    fixture.store.claimForApproval(proposal.proposalId, Date.now());
    fixture.store.applyUpdateEffect(proposal.proposalId, Date.now());
    const committed = fixture.dynamicStore.getById(original.id);
    const later = createProposal({
      proposalId: 'later-update',
      mutation: {
        kind: 'update',
        taskId: original.id,
        taskSnapshot: committed,
        expectedFingerprint: fingerprintDynamicTaskDef(committed),
        params: { ...committed.params, message: 'later approved edit' },
      },
    });
    fixture.store.create(later);
    fixture.anchor(later);
    assert.equal((await fixture.decide(later.proposalId, 'approve')).statusCode, 200);
    const response = await fixture.decide(proposal.proposalId, 'approve');
    assert.equal(response.statusCode, 200);
    assert.equal(fixture.dynamicStore.getById(original.id).params.message, 'later approved edit');
    assert.equal(fixture.store.getById(proposal.proposalId).status, 'approved');
    assert.equal(fixture.store.listPending(OWNER).length, 0);
    assert.equal(fixture.store.listAudit(OWNER).length, 2);
    await fixture.runner.triggerNow(original.id);
    assert.match(delivered[0].content, /later approved edit/);
  });

  it('revalidates the template before claim and leaves a paused task paused', async () => {
    fixture.anchor(proposal);
    fixture.db
      .prepare('UPDATE schedule_mutation_proposals SET mutation_json = ? WHERE proposal_id = ?')
      .run(JSON.stringify({ ...proposal.mutation, params: { ...original.params, message: 42 } }), proposal.proposalId);
    assert.equal((await fixture.decide(proposal.proposalId, 'approve')).statusCode, 409);
    assert.equal(fixture.store.getById(proposal.proposalId).status, 'pending');
    fixture.db.prepare('UPDATE dynamic_task_defs SET enabled = 0 WHERE id = ?').run(original.id);
    fixture.runner.unregister(original.id);
    const paused = fixture.dynamicStore.getById(original.id);
    fixture.db.prepare('UPDATE schedule_mutation_proposals SET mutation_json = ? WHERE proposal_id = ?').run(
      JSON.stringify({
        ...proposal.mutation,
        taskSnapshot: paused,
        expectedFingerprint: fingerprintDynamicTaskDef(paused),
      }),
      proposal.proposalId,
    );
    assert.equal((await fixture.decide(proposal.proposalId, 'approve')).statusCode, 200);
    assert.equal(fixture.dynamicStore.getById(original.id).enabled, false);
    assert.equal(fixture.runner.getTaskSummaries().length, 0);
  });
});
