import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectEvalRepairEvolutionSnapshot } from '../../dist/infrastructure/harness-eval/eval-repair-evolution-owner-projection.js';
import { supersedeEvalRepairApproval } from '../../dist/infrastructure/harness-eval/eval-repair-supersession.js';
import {
  actionRef,
  caseId,
  dispatchRef,
  fixture,
  ownerAuthorizationRef,
  ownerRef,
  principal,
  ref,
  targetVersionRef,
} from './eval-repair-approval-fixtures.js';

const ownerLineage = {
  programRef: ref('F311', 'program:terminal-snapshot'),
  cycleRef: ref('F311', 'cycle:terminal-snapshot:1'),
  interventionRef: ref('F311', 'intervention:terminal-snapshot:1'),
};

async function proposedContext() {
  const approval = fixture();
  const proposed = await approval.service.propose({
    caseActionRef: actionRef,
    clientMessageId: 'terminal-snapshot-request',
    principal,
    ownerLineage,
  });
  assert.equal(proposed.status, 'published');
  return { approval, proposalId: proposed.proposalId };
}

async function snapshotOf(ctx) {
  return projectEvalRepairEvolutionSnapshot(await ctx.approval.eventLog.read(caseId), ctx.proposalId);
}

describe('F313 Phase D terminal owner snapshot refs', () => {
  it('keeps pending append-free and exposes no invented decision ref', async () => {
    const ctx = await proposedContext();
    const snapshot = await snapshotOf(ctx);
    assert.equal(snapshot.status, 'pending');
    assert.equal(snapshot.decisionRef, undefined);
  });

  it('projects the canonical Approval ref as the reject/withdraw closure decision ref', async () => {
    for (const [decision, status] of [
      ['reject', 'rejected'],
      ['withdraw', 'withdrawn'],
    ]) {
      const ctx = await proposedContext();
      await ctx.approval.service.decide({
        proposalId: ctx.proposalId,
        decision,
        reasonCode: decision === 'reject' ? 'wrong_target' : 'not_now',
        decidedByUserId: principal.userId,
      });
      const snapshot = await snapshotOf(ctx);
      assert.equal(snapshot.status, status);
      assert.deepEqual(snapshot.decisionRef, snapshot.approvalRef);
    }
  });

  it('projects an owner-backed F266 decision ref for owner and target supersession', async () => {
    for (const [drift, status] of [
      ['owner', 'superseded'],
      ['target', 'target_drift'],
    ]) {
      const ctx = await proposedContext();
      const result = await supersedeEvalRepairApproval({
        eventLog: ctx.approval.eventLog,
        caseId,
        proposalId: ctx.proposalId,
        owner: {
          ownerRef: drift === 'owner' ? ref('F313', 'owner:f188:other') : ownerRef,
          ownerAuthorizationRef,
          targetVersionRef: drift === 'target' ? { ...targetVersionRef, version: 'target-v2' } : targetVersionRef,
          dispatchRef,
        },
        drift,
        occurredAt: '2026-09-02T00:20:00.000Z',
      });
      assert.equal(result.status, 'superseded');
      const snapshot = await snapshotOf(ctx);
      assert.equal(snapshot.status, status);
      assert.equal(snapshot.decisionRef.ownerFeatureId, 'F266');
      assert.match(snapshot.decisionRef.ownerStateRef, /^eval-repair-supersession:/);
    }
  });
});
