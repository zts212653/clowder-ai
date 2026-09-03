import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  actionRef,
  caseAction,
  caseId,
  dispatchRef,
  fixture,
  MemoryEventLog,
  ownerAuthorizationRef,
  ownerRef,
  principal,
  proposeAndAccept,
  ref,
  targetVersionRef,
} from './eval-repair-approval-fixtures.js';

class AckLossEventLog extends MemoryEventLog {
  lost = false;

  async append(event, expectedSequence) {
    const result = await super.append(event, expectedSequence);
    if (!this.lost && event.type === 'approval_superseded' && result.outcome === 'appended') {
      this.lost = true;
      throw new Error('simulated supersession append acknowledgement loss');
    }
    return result;
  }
}

describe('F313/F266 Approval snapshot drift', () => {
  it('supersedes an open proposal before creating its linked replacement', async () => {
    const ctx = fixture();
    const original = await ctx.service.propose({ caseActionRef: actionRef, clientMessageId: 'client-1', principal });
    ctx.setOwner({
      status: 'resolved',
      ownerRef,
      ownerAuthorizationRef: ref('F188', 'authorization:repair:f188:v2'),
      targetVersionRef,
      dispatchRef,
    });

    const drifted = await ctx.service.propose({ caseActionRef: actionRef, clientMessageId: 'client-2', principal });

    assert.equal(drifted.status, 'superseded');
    assert.equal(drifted.drift, 'authorization');
    assert.deepEqual(ctx.counts(), { proposals: 1, cards: 1, tasks: 0, leases: 0, mutations: 0 });
    const events = await ctx.eventLog.read(caseId);
    assert.equal(events.at(-1).type, 'approval_superseded');

    ctx.actions.set(drifted.freshCaseActionRef, caseAction({ supersedesProposalId: original.proposalId }));
    const replacement = await ctx.service.propose({
      caseActionRef: drifted.freshCaseActionRef,
      clientMessageId: 'client-3',
      principal,
    });
    assert.equal(replacement.status, 'published');
    assert.notEqual(replacement.proposalId, original.proposalId);
    assert.deepEqual(ctx.counts(), { proposals: 2, cards: 2, tasks: 0, leases: 0, mutations: 0 });
    const proposalEvents = (await ctx.eventLog.read(caseId)).filter((event) => event.type === 'approval_proposed');
    assert.equal(proposalEvents.at(-1).supersedesProposalId, original.proposalId);
  });

  it('supersedes accepted Approval on owner/auth/target drift and exposes a linked fresh cycle', async () => {
    for (const [field, replacement] of [
      ['ownerRef', ref('F313', 'owner:f188:terra')],
      ['ownerAuthorizationRef', ref('F188', 'authorization:repair:f188:v2')],
      ['targetVersionRef', { ...targetVersionRef, version: `repair-target-v1-${'c'.repeat(64)}` }],
    ]) {
      const ctx = fixture();
      const proposed = await proposeAndAccept(ctx);
      ctx.setOwner({
        status: 'resolved',
        ownerRef,
        ownerAuthorizationRef,
        targetVersionRef,
        dispatchRef,
        [field]: replacement,
      });
      const result = await ctx.service.materialize(proposed.proposalId);
      assert.equal(result.status, 'superseded');
      assert.ok(result.freshCaseActionRef);
      assert.deepEqual(ctx.counts(), { proposals: 1, cards: 1, tasks: 0, leases: 0, mutations: 0 });
      const events = await ctx.eventLog.read(caseId);
      assert.equal(events.at(-1).type, 'approval_superseded');
    }
  });

  it('recovers the linked fresh cycle from the single supersession event after acknowledgement loss', async () => {
    const eventLog = new AckLossEventLog();
    const ctx = fixture({ eventLog });
    const original = await proposeAndAccept(ctx);
    ctx.setOwner({
      status: 'resolved',
      ownerRef,
      ownerAuthorizationRef: ref('F188', 'authorization:repair:f188:v2'),
      targetVersionRef,
      dispatchRef,
    });

    await assert.rejects(
      () => ctx.service.materialize(original.proposalId),
      /supersession append acknowledgement loss/,
    );
    const events = await eventLog.read(caseId);
    assert.equal(events.filter((event) => event.type === 'approval_superseded').length, 1);
    assert.equal(events.filter((event) => event.type === 'case_ready_for_proposal').length, 0);

    const recovered = await ctx.service.materialize(original.proposalId);
    assert.equal(recovered.status, 'superseded');
    assert.equal(recovered.drift, 'authorization');
    assert.ok(recovered.freshCaseActionRef);
    assert.deepEqual(ctx.counts(), { proposals: 1, cards: 1, tasks: 0, leases: 0, mutations: 0 });
  });

  it('lets the canonical owner atomically reject drift that appears after dispatch preflight', async () => {
    let changed = false;
    const ctx = fixture({
      beforeDispatchValidation({ setOwner }) {
        if (changed) return;
        changed = true;
        setOwner({
          status: 'resolved',
          ownerRef,
          ownerAuthorizationRef: ref('F188', 'authorization:repair:f188:v2'),
          targetVersionRef,
          dispatchRef,
        });
      },
    });
    const original = await proposeAndAccept(ctx);

    const result = await ctx.service.materialize(original.proposalId);

    assert.equal(result.status, 'superseded');
    assert.equal(result.drift, 'authorization');
    assert.deepEqual(ctx.counts(), { proposals: 1, cards: 1, tasks: 0, leases: 0, mutations: 0 });
    const events = await ctx.eventLog.read(caseId);
    assert.equal(events.filter((event) => event.type === 'approval_materialization_started').length, 1);
    assert.equal(events.at(-1).type, 'approval_superseded');
  });

  it('does not let a concurrent proposal supersede a reserved dispatch before owner validation', async () => {
    let interleavedProposal;
    let ctx;
    ctx = fixture({
      async beforeDispatchValidation({ setOwner }) {
        setOwner({
          status: 'resolved',
          ownerRef,
          ownerAuthorizationRef: ref('F188', 'authorization:repair:f188:v2'),
          targetVersionRef,
          dispatchRef,
        });
        interleavedProposal = await ctx.service.propose({
          caseActionRef: actionRef,
          clientMessageId: 'client-interleaved',
          principal,
        });
      },
    });
    const original = await proposeAndAccept(ctx);

    const result = await ctx.service.materialize(original.proposalId);

    assert.deepEqual(interleavedProposal, {
      status: 'blocked',
      reason: 'approval_materialization_in_progress',
    });
    assert.equal(result.status, 'superseded');
    assert.deepEqual(ctx.counts(), { proposals: 1, cards: 1, tasks: 0, leases: 0, mutations: 0 });
  });

  it('keeps the old Approval inert and materializes exactly one custody after fresh re-approval', async () => {
    const ctx = fixture();
    const original = await proposeAndAccept(ctx);
    ctx.setOwner({
      status: 'resolved',
      ownerRef,
      ownerAuthorizationRef: ref('F188', 'authorization:repair:f188:v2'),
      targetVersionRef,
      dispatchRef,
    });
    const superseded = await ctx.service.materialize(original.proposalId);
    assert.equal(superseded.status, 'superseded');
    assert.equal((await ctx.service.materialize(original.proposalId)).status, 'superseded');

    ctx.actions.set(superseded.freshCaseActionRef, caseAction({ supersedesProposalId: original.proposalId }));
    const replacement = await ctx.service.propose({
      caseActionRef: superseded.freshCaseActionRef,
      clientMessageId: 'client-fresh',
      principal,
    });
    assert.equal(replacement.status, 'published');
    const decision = await ctx.service.decide({
      proposalId: replacement.proposalId,
      decision: 'accept',
      reasonCode: 'accepted_as_proposed',
      decidedByUserId: 'owner-user',
    });
    assert.equal(decision.status, 'accepted');
    assert.equal((await ctx.service.materialize(replacement.proposalId)).status, 'materialized');
    assert.equal((await ctx.service.materialize(replacement.proposalId)).status, 'duplicate');
    assert.deepEqual(ctx.counts(), { proposals: 2, cards: 2, tasks: 1, leases: 1, mutations: 0 });
  });
});
