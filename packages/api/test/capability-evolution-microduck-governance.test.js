import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createMicroduckApprovalResolver,
  createMicroduckProposalResolver,
} from '../dist/infrastructure/capability-evolution/adapters/microduck-governance-resolvers.js';
import { evalRepairProposalRef } from '../dist/infrastructure/harness-eval/eval-repair-outcome-refs.js';
import { supersedeEvalRepairApproval } from '../dist/infrastructure/harness-eval/eval-repair-supersession.js';
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
} from './harness-eval/eval-repair-approval-fixtures.js';

const ownerLineage = {
  programRef: ref('F311', 'program:microduck-show'),
  cycleRef: ref('F311', 'cycle:microduck-show:1'),
  interventionRef: ref('microduck-owner', `config-diff:sha256:${'c'.repeat(64)}`),
};

async function proposed() {
  const approval = fixture();
  const result = await approval.service.propose({
    caseActionRef: actionRef,
    clientMessageId: 'microduck-show-proposal',
    principal,
    ownerLineage,
  });
  assert.equal(result.status, 'published');
  return { approval, proposalRef: evalRepairProposalRef(result.proposalId), proposalId: result.proposalId };
}

describe('F311 Microduck canonical F266/F246 governance resolvers', () => {
  it('projects only an anchored, open proposal with exact F311 owner lineage', async () => {
    const context = await proposed();
    const resolver = createMicroduckProposalResolver(context.approval.eventLog);

    assert.deepEqual(await resolver.resolve({ proposalRef: context.proposalRef }), {
      status: 'pending',
      proposalRef: context.proposalRef,
      ...ownerLineage,
      targetVersionRef,
    });

    await context.approval.service.decide({
      proposalId: context.proposalId,
      decision: 'withdraw',
      reasonCode: 'not_now',
      decidedByUserId: principal.userId,
    });
    assert.deepEqual(await resolver.resolve({ proposalRef: context.proposalRef }), {
      status: 'blocked',
      code: 'approval_missing',
    });
  });

  it('projects an accepted F246 decision from the same canonical proposal and lineage', async () => {
    const context = await proposed();
    const accepted = await context.approval.service.decide({
      proposalId: context.proposalId,
      decision: 'accept',
      reasonCode: 'accepted_as_proposed',
      decidedByUserId: principal.userId,
    });
    assert.equal(accepted.status, 'accepted');
    const resolver = createMicroduckApprovalResolver(context.approval.eventLog);
    const resolved = await resolver.resolve({ proposalRef: context.proposalRef });

    assert.equal(resolved.status, 'approved');
    assert.deepEqual(resolved.proposalRef, context.proposalRef);
    assert.deepEqual(resolved.programRef, ownerLineage.programRef);
    assert.deepEqual(resolved.cycleRef, ownerLineage.cycleRef);
    assert.deepEqual(resolved.interventionRef, ownerLineage.interventionRef);
    assert.deepEqual(resolved.targetVersionRef, targetVersionRef);
    assert.equal(resolved.approvalRef.ownerFeatureId, 'F246');
  });

  it('rejects a canonically superseded proposal as stale', async () => {
    const context = await proposed();
    const superseded = await supersedeEvalRepairApproval({
      eventLog: context.approval.eventLog,
      caseId,
      proposalId: context.proposalId,
      owner: {
        ownerRef,
        ownerAuthorizationRef,
        targetVersionRef: { ...targetVersionRef, version: 'target-v2' },
        dispatchRef,
      },
      drift: 'target',
      occurredAt: '2026-09-04T02:00:00.000Z',
    });
    assert.equal(superseded.status, 'superseded');
    assert.deepEqual(
      await createMicroduckProposalResolver(context.approval.eventLog).resolve({
        proposalRef: context.proposalRef,
      }),
      { status: 'blocked', code: 'approval_missing' },
    );
  });

  it('fails closed when canonical lifecycle persistence is unavailable', async () => {
    const proposalRef = evalRepairProposalRef('unavailable');
    assert.deepEqual(await createMicroduckProposalResolver().resolve({ proposalRef }), {
      status: 'blocked',
      code: 'approval_missing',
    });
    assert.deepEqual(await createMicroduckApprovalResolver().resolve({ proposalRef }), {
      status: 'blocked',
      code: 'approval_missing',
    });
  });
});
