import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  GOVERNANCE_REMINDER_INTERVAL_MS,
  harness,
  principal,
  writeEvaluation,
} from './f257-cycle-governance-fixture.js';

describe('F257 cycle governance closure', () => {
  test('complete evaluation automatically sends bounded same-thread governance with history and no bodies', async () => {
    const context = await harness();
    await writeEvaluation(context);

    assert.equal(context.deliveries.length, 1);
    const delivery = context.deliveries[0];
    assert.equal(delivery.threadId, principal.threadId);
    assert.ok(Buffer.byteLength(delivery.content) <= 32 * 1024);
    assert.match(delivery.content, /Cycle Governance Assignment/);
    assert.match(delivery.content, /"statement":"Keep the behavior sound\."/);
    assert.match(delivery.content, /"history":\[\]/);
    assert.doesNotMatch(delivery.content, /v1 body|traceCorpus/);
    assert.ok((await context.cycles.current('owner-1', 'obj')).governanceAssignedAt);
  });

  test('keep advances immediately without creating an approval card', async () => {
    const context = await harness();
    await writeEvaluation(context);
    const record = await context.cycles.current('owner-1', 'obj');
    const result = await context.governance.submitGovernance(principal, {
      objectiveId: 'obj',
      cycleId: record.cycleId,
      decision: 'keep',
      reason: 'No change is warranted.',
    });

    assert.equal(result.decision, 'keep');
    assert.equal((await context.proposals.listByOwner('owner-1')).length, 0);
    const next = await context.cycles.current('owner-1', 'obj');
    assert.equal(next.evalStatus, 'idle');
    assert.equal(next.cycleStart, 1_000);
  });

  test('reject requires a reason, re-evaluates the same windows, and produces a new card generation', async () => {
    const context = await harness();
    await writeEvaluation(context);
    let record = await context.cycles.current('owner-1', 'obj');
    const first = await context.governance.submitGovernance(principal, {
      objectiveId: 'obj',
      cycleId: record.cycleId,
      decision: 'evolve',
      reason: 'Tighten the rule.',
      v2Draft: { changes: [{ action: 'modify', unitId: 'D1', reason: 'Clarify', proposedContent: 'v2 body' }] },
    });
    const proposal = await context.proposals.get(first.proposalId);
    assert.equal(proposal.objective.label, 'Objective');
    assert.deepEqual(proposal.triggerCounts, {
      cumulative: { count: 0, threshold: 3 },
      counterexamples: { count: 0, threshold: 2 },
    });
    assert.equal(proposal.changes[0].beforeContent, 'v1 body');
    assert.equal(proposal.changes[0].proposedContent, 'v2 body');
    const retry = await context.governance.submitGovernance(principal, {
      objectiveId: 'obj',
      cycleId: record.cycleId,
      decision: 'evolve',
      reason: 'Tighten the rule.',
      v2Draft: { changes: [{ action: 'modify', unitId: 'D1', reason: 'Clarify', proposedContent: 'v2 body' }] },
    });
    assert.equal(retry.outcome, 'already_written');
    assert.equal(retry.proposalId, first.proposalId);
    assert.equal((await context.proposals.listByOwner('owner-1')).length, 1);
    await assert.rejects(
      context.governance.rejectProposal('owner-1', first.proposalId, 'owner-1', ''),
      /reject_reason_required/,
    );
    await context.governance.rejectProposal('owner-1', first.proposalId, 'owner-1', 'Need stronger evidence.');

    record = await context.cycles.current('owner-1', 'obj');
    assert.equal(record.cycleId, proposal.cycleId);
    assert.equal(record.evalStatus, 'requested');
    assert.deepEqual(record.windows, [{ start: 0, end: 1_000 }]);
    assert.deepEqual(record.rejectReasons, ['Need stronger evidence.']);
    assert.equal(context.deliveries.length, 2, 'reject must deliver a fresh evaluation assignment generation');
    assert.match(context.deliveries[1].content, /Need stronger evidence\./);
    assert.match(context.deliveries[1].content, /current CycleRecord is awaiting a fresh evaluation writeback/);
    assert.match(context.deliveries[1].content, /Earlier governance cards in this thread are settled history/);

    context.clock.now += 1_000;
    await writeEvaluation(context);
    assert.equal(context.deliveries.length, 3, 'reevaluation must deliver a fresh governance assignment generation');
    assert.match(context.deliveries[2].content, /current CycleRecord is awaiting a fresh governance writeback/);
    assert.match(context.deliveries[2].content, /Do not reuse an earlier proposalId/);
    record = await context.cycles.current('owner-1', 'obj');
    const second = await context.governance.submitGovernance(principal, {
      objectiveId: 'obj',
      cycleId: record.cycleId,
      decision: 'evolve',
      reason: 'Now supported.',
      v2Draft: { changes: [{ action: 'modify', unitId: 'D1', reason: 'Clarify', proposedContent: 'v2 body' }] },
    });
    assert.notEqual(second.proposalId, first.proposalId);
    const secondProposal = await context.proposals.get(second.proposalId);
    assert.equal(secondProposal.cardOrdinal, 2);
    assert.deepEqual(secondProposal.rejectReasons, ['Need stronger evidence.']);
  });

  test('approve applies and advances to v2 while skip advances on the existing version', async () => {
    const approved = await harness();
    await writeEvaluation(approved);
    let record = await approved.cycles.current('owner-1', 'obj');
    const evolution = await approved.governance.submitGovernance(principal, {
      objectiveId: 'obj',
      cycleId: record.cycleId,
      decision: 'evolve',
      reason: 'Use v2.',
      v2Draft: { changes: [{ action: 'modify', unitId: 'D1', reason: 'Clarify', proposedContent: 'v2 body' }] },
    });
    await approved.governance.approveProposal('owner-1', evolution.proposalId, 'owner-1', 'Approved.');
    assert.equal(approved.applied.length, 1);
    assert.equal((await approved.proposals.get(evolution.proposalId)).status, 'approved');
    assert.equal((await approved.cycles.current('owner-1', 'obj')).version, 'v2');

    const skipped = await harness();
    await writeEvaluation(skipped);
    record = await skipped.cycles.current('owner-1', 'obj');
    const candidate = await skipped.governance.submitGovernance(principal, {
      objectiveId: 'obj',
      cycleId: record.cycleId,
      decision: 'rollback',
      reason: 'Consider v1.',
      rollback: { unitId: 'D1', targetVersion: 1 },
    });
    await skipped.governance.skipProposal('owner-1', candidate.proposalId, 'owner-1', 'Collect more data.');
    assert.equal(skipped.applied.length, 0);
    assert.equal((await skipped.proposals.get(candidate.proposalId)).status, 'skipped');
    assert.equal((await skipped.cycles.current('owner-1', 'obj')).version, 'v1');
  });

  test('missing-card reminder is daily and only runs while the Objective thread is quiescent', async () => {
    const context = await harness();
    await writeEvaluation(context);
    const record = await context.cycles.current('owner-1', 'obj');
    context.clock.now = record.governanceAssignedAt + GOVERNANCE_REMINDER_INTERVAL_MS;
    context.setQuiescent(false);
    await context.governance.reconcileKnownCycles(context.clock.now);
    assert.equal(context.deliveries.length, 1);

    context.setQuiescent(true);
    await context.governance.reconcileKnownCycles(context.clock.now);
    await context.governance.reconcileKnownCycles(context.clock.now + 1);
    assert.equal(context.deliveries.filter((item) => item.content.includes('Card Missing')).length, 1);

    context.clock.now += GOVERNANCE_REMINDER_INTERVAL_MS;
    await context.governance.reconcileKnownCycles(context.clock.now);
    assert.equal(context.deliveries.filter((item) => item.content.includes('Card Missing')).length, 2);
  });
});
