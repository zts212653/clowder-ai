import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryRequestReviewOwnerLedger } from '../dist/infrastructure/capability-evolution/adapters/request-review/request-review-owner-ledger.js';
import { createRequestReviewDecisionOwner } from '../dist/infrastructure/capability-evolution/change/request-review-decision-owner.js';
import { RequestReviewLineageBindingResolver } from '../dist/infrastructure/capability-evolution/change/request-review-lineage-binding-resolver.js';
import { RequestReviewOwnerReceiptService } from '../dist/infrastructure/capability-evolution/change/request-review-owner-receipts.js';
import { actionRef, caseAction, fixture, principal, ref } from './harness-eval/eval-repair-approval-fixtures.js';

const targetVersionRef = {
  ownerFeatureId: 'F100',
  ownerStateRef: 'skill:cat-cafe-skills/request-review/SKILL.md',
  version: 'a'.repeat(64),
  assetKind: 'skill',
  assetId: 'cat-cafe-skills/request-review/SKILL.md',
};
const candidateVersionRef = { ...targetVersionRef, version: 'b'.repeat(64) };
const ownerSnapshot = {
  status: 'resolved',
  ownerRef: ref('F100', 'owner:request-review'),
  ownerAuthorizationRef: ref('F100', `authorization:request-review:${targetVersionRef.version}`),
  targetVersionRef,
  dispatchRef: ref('F100', `dispatch:request-review:${targetVersionRef.version}`),
};
const mainCommitSha = 'c'.repeat(40);
const loadedRuntimeRef = ref('F302', 'runtime:alpha', mainCommitSha);
const ownerLineage = {
  programRef: { ownerFeatureId: 'F311', ownerStateRef: 'evolution-program:ba0f4524e49cc879279164d5b272cf8c' },
  cycleRef: {
    ownerFeatureId: 'F311',
    ownerStateRef: 'evolution-cycle:evolution-program:ba0f4524e49cc879279164d5b272cf8c:1',
  },
  interventionRef: {
    ownerFeatureId: 'F100',
    ownerStateRef: 'capability:development-process-harness-effectiveness',
  },
};
const requestReviewRepairTarget = {
  featureId: 'F100',
  componentId: ownerLineage.interventionRef.ownerStateRef,
  version: targetVersionRef.version,
};

async function approvedContext({
  materialize = true,
  allowedTransition = true,
  proposalLineage = ownerLineage,
  repairTarget = requestReviewRepairTarget,
} = {}) {
  const approval = fixture({ ownerSnapshot });
  approval.actions.set(actionRef, caseAction({ repairTarget }));
  const proposed = await approval.service.propose({
    caseActionRef: actionRef,
    clientMessageId: 'request-review-owner-receipt-proposal',
    principal,
    ownerLineage: proposalLineage,
  });
  assert.equal(proposed.status, 'published');
  const accepted = await approval.service.decide({
    proposalId: proposed.proposalId,
    decision: 'accept',
    reasonCode: 'accepted_as_proposed',
    decidedByUserId: 'owner-user',
  });
  assert.equal(accepted.status, 'accepted');
  if (materialize) {
    const result = await approval.service.materialize(proposed.proposalId);
    assert.equal(result.status, 'materialized');
  }
  const ledger = new MemoryRequestReviewOwnerLedger();
  const lineageBindingResolver = new RequestReviewLineageBindingResolver({
    readBindings: async () => [
      {
        programRef: {
          ownerFeatureId: 'F311',
          ownerStateRef: 'evolution-program:ba0f4524e49cc879279164d5b272cf8c',
        },
        cycleRef: {
          ownerFeatureId: 'F311',
          ownerStateRef: 'evolution-cycle:evolution-program:ba0f4524e49cc879279164d5b272cf8c:1',
        },
        interventionRef: {
          ownerFeatureId: 'F100',
          ownerStateRef: 'capability:development-process-harness-effectiveness',
        },
        assetVersionRef: targetVersionRef,
        caseActionRef: actionRef,
      },
    ],
    resolveCaseAction: async (refValue) => approval.actions.get(refValue) ?? null,
    versionReader: { currentVersionRef: async () => targetVersionRef },
  });
  const receipts = new RequestReviewOwnerReceiptService({
    eventLog: approval.eventLog,
    ledger,
    lineageBindingResolver,
    versionVerifier: {
      async verifyCommitVersion(commitSha, assetVersion) {
        return (
          commitSha === mainCommitSha &&
          [targetVersionRef.version, candidateVersionRef.version].includes(assetVersion.version)
        );
      },
      async verifyAllowedTransition() {
        return allowedTransition;
      },
      async isKnownVersion(assetVersion) {
        return [targetVersionRef.version, candidateVersionRef.version].includes(assetVersion.version);
      },
    },
    releaseTruth: {
      loadedRuntimeHead: mainCommitSha,
      verifyMainLanded(commitSha) {
        return { commitSha, evidenceRef: `main:${commitSha}` };
      },
      verifyLiveActive(commitSha) {
        return { commitSha, evidenceRef: `live:${commitSha}` };
      },
    },
    now: () => '2026-09-12T10:30:00.000Z',
  });
  return { approval, proposed, ledger, receipts, lineageBindingResolver };
}

function changedInput(proposalId, overrides = {}) {
  return {
    proposalId,
    assetVersionRef: candidateVersionRef,
    mainCommitSha,
    loadedRuntimeRef,
    changedAt: '2026-09-12T10:20:00.000Z',
    loadedAt: '2026-09-12T10:25:00.000Z',
    ...overrides,
  };
}

describe('F100 request-review owner receipts', () => {
  it('records a Git-attested loaded intervention and derives F266 bindings only at read time', async () => {
    const ctx = await approvedContext();
    const recorded = await ctx.receipts.recordChanged(changedInput(ctx.proposed.proposalId));
    assert.equal(recorded.status, 'recorded');
    assert.match(recorded.receiptRef.ownerStateRef, /^intervention:request-review-/);

    const event = (await ctx.ledger.read())[0];
    assert.equal(event.type, 'intervention_changed');
    for (const copied of ['caseRef', 'approvalRef', 'ownerAuthorizationRef', 'taskRef', 'leaseRef']) {
      assert.equal(Object.hasOwn(event, copied), false, `${copied} must remain in its canonical owner`);
    }

    const resolved = await ctx.receipts.resolveIntervention(recorded.receiptRef);
    assert.equal(resolved.kind, 'changed');
    assert.deepEqual(resolved.assetVersionRef, candidateVersionRef);
    assert.equal(resolved.proposalRef.ownerStateRef, `eval-repair-proposal:${ctx.proposed.proposalId}`);
    assert.equal(resolved.approvalRef.ownerFeatureId, 'F246');
    assert.deepEqual(resolved.targetVersionRef, targetVersionRef);

    const duplicate = await ctx.receipts.recordChanged(changedInput(ctx.proposed.proposalId));
    assert.equal(duplicate.status, 'duplicate');
    assert.deepEqual(duplicate.receiptRef, recorded.receiptRef);
  });

  it('has zero owner-ledger effects for unmaterialized approval or mismatched Git bytes', async () => {
    const pending = await approvedContext({ materialize: false });
    assert.deepEqual(await pending.receipts.recordChanged(changedInput(pending.proposed.proposalId)), {
      status: 'blocked',
      reason: 'approval_not_materialized',
    });
    assert.equal((await pending.ledger.read()).length, 0);

    const wrongBytes = await approvedContext();
    const result = await wrongBytes.receipts.recordChanged(
      changedInput(wrongBytes.proposed.proposalId, {
        assetVersionRef: { ...candidateVersionRef, version: 'd'.repeat(64) },
      }),
    );
    assert.deepEqual(result, { status: 'blocked', reason: 'asset_version_unverified' });
    assert.equal((await wrongBytes.ledger.read()).length, 0);

    const immutableDrift = await approvedContext({ allowedTransition: false });
    assert.deepEqual(await immutableDrift.receipts.recordChanged(changedInput(immutableDrift.proposed.proposalId)), {
      status: 'blocked',
      reason: 'asset_transition_unverified',
    });
    assert.equal((await immutableDrift.ledger.read()).length, 0);
  });

  it('rejects unrelated and foreign-lineage evidence before every owner-ledger append', async () => {
    const scenarios = [
      {
        name: 'unrelated target',
        repairTarget: {
          featureId: 'F188',
          componentId: 'memory:evidence-reader',
          version: targetVersionRef.version,
        },
      },
      {
        name: 'foreign Program/cycle',
        proposalLineage: {
          ...ownerLineage,
          programRef: { ...ownerLineage.programRef, ownerStateRef: 'evolution-program:foreign' },
          cycleRef: { ...ownerLineage.cycleRef, ownerStateRef: 'evolution-cycle:evolution-program:foreign:1' },
        },
      },
    ];
    for (const scenario of scenarios) {
      const ctx = await approvedContext(scenario);
      assert.deepEqual(
        await ctx.receipts.linkEvidence({
          proposalId: ctx.proposed.proposalId,
          assetVersionRef: targetVersionRef,
          role: 'candidate_independent_verification',
          evidenceRef: ref('F192', `evidence:${scenario.name}`),
          proofRef: ref('F267', `proof:${scenario.name}`),
          status: 'verified',
        }),
        { status: 'blocked', reason: 'binding_missing' },
      );
      assert.deepEqual(await ctx.ledger.read(), []);
    }
  });

  it('records all three evidence roles and a fresh outcome without turning them into one another', async () => {
    const ctx = await approvedContext();
    const changed = await ctx.receipts.recordChanged(changedInput(ctx.proposed.proposalId));
    assert.equal(changed.status, 'recorded');
    const unknownEvidence = await ctx.receipts.linkEvidence({
      assetVersionRef: { ...candidateVersionRef, version: 'e'.repeat(64) },
      proposalId: ctx.proposed.proposalId,
      role: 'comparison_baseline',
      evidenceRef: ref('F192', 'evidence:unknown-version'),
      proofRef: ref('F267', 'proof:unknown-version'),
      status: 'verified',
    });
    assert.deepEqual(unknownEvidence, { status: 'blocked', reason: 'asset_version_unverified' });
    for (const role of ['comparison_baseline', 'candidate_independent_verification', 'post_adoption_observation']) {
      const linked = await ctx.receipts.linkEvidence({
        assetVersionRef: candidateVersionRef,
        proposalId: ctx.proposed.proposalId,
        role,
        evidenceRef: ref('F192', `evidence:${role}`),
        proofRef: ref('F267', `proof:${role}`),
        status: 'verified',
      });
      assert.equal(linked.status, 'recorded');
    }
    const outcome = await ctx.receipts.recordFreshOutcome({
      proposalId: ctx.proposed.proposalId,
      interventionReceiptRef: changed.receiptRef,
      reevaluationRef: ref('F267', 'reeval:f100-cycle-1'),
      freshnessProofRef: ref('F267', 'freshness:f100-cycle-1'),
      outcome: 'insufficient_observe',
      loadedRuntimeRef,
      measuredAt: '2026-09-12T10:29:00.000Z',
      uncontaminated: true,
    });
    assert.equal(outcome.status, 'recorded');
    const resolved = await ctx.receipts.resolveFreshOutcome(outcome.receiptRef);
    assert.equal(resolved.outcome, 'insufficient_observe');
    assert.deepEqual(resolved.interventionReceiptRef, changed.receiptRef);

    const events = await ctx.ledger.read();
    assert.equal(events.filter((event) => event.type === 'evidence_linked').length, 3);
    assert.equal(events.filter((event) => event.type === 'fresh_outcome_recorded').length, 1);

    const decisionOwner = createRequestReviewDecisionOwner({
      eventLog: ctx.approval.eventLog,
      ledger: ctx.ledger,
      lineageBindingResolver: ctx.lineageBindingResolver,
    });
    const decisionInput = {
      programRef: { ownerFeatureId: 'F311', ownerStateRef: 'evolution-program:ba0f4524e49cc879279164d5b272cf8c' },
      cycleRef: {
        ownerFeatureId: 'F311',
        ownerStateRef: 'evolution-cycle:evolution-program:ba0f4524e49cc879279164d5b272cf8c:1',
      },
      caseRef: resolved.caseRef,
      proposalRef: resolved.proposalRef,
      outcomeReceiptRef: outcome.receiptRef,
      decision: 'keep',
      clientMessageId: 'keep-cycle-1',
      idempotencyRef: 'decision:f100:keep-cycle-1',
      decisionAuthorityRef: { ownerFeatureId: 'F311', ownerStateRef: 'value-owner-session:owner-user' },
    };
    const blockedDecisionOwner = createRequestReviewDecisionOwner({
      eventLog: ctx.approval.eventLog,
      ledger: ctx.ledger,
      lineageBindingResolver: {
        resolveProposalScope: async () => ({ status: 'blocked', reason: 'lineage_mismatch' }),
      },
    });
    assert.deepEqual(await blockedDecisionOwner.execute(decisionInput), {
      status: 'blocked',
      reason: 'proposal_mismatch',
    });
    assert.equal((await ctx.ledger.read()).filter((event) => event.type === 'decision_recorded').length, 0);
    const decided = await decisionOwner.execute(decisionInput);
    assert.equal(decided.status, 'recorded');
    assert.match(decided.decisionRef.ownerStateRef, /^decision:request-review-/);
    assert.equal((await decisionOwner.execute(decisionInput)).status, 'duplicate');
  });

  it('records a verified rollback as a distinct owner action and adoption proof', async () => {
    const ctx = await approvedContext();
    const withoutChange = await ctx.receipts.recordRollback({
      proposalId: ctx.proposed.proposalId,
      restoredVersionRef: candidateVersionRef,
      mainCommitSha,
      loadedRuntimeRef,
      restoredAt: '2026-09-12T10:20:00.000Z',
      loadedAt: '2026-09-12T10:25:00.000Z',
    });
    assert.deepEqual(withoutChange, { status: 'blocked', reason: 'intervention_receipt_missing' });
    assert.equal((await ctx.ledger.read()).length, 0);

    const changed = await ctx.receipts.recordChanged(changedInput(ctx.proposed.proposalId));
    assert.equal(changed.status, 'recorded');
    const wrongTarget = await ctx.receipts.recordRollback({
      proposalId: ctx.proposed.proposalId,
      interventionReceiptRef: changed.receiptRef,
      restoredVersionRef: candidateVersionRef,
      mainCommitSha,
      loadedRuntimeRef,
      restoredAt: '2026-09-12T10:26:00.000Z',
      loadedAt: '2026-09-12T10:27:00.000Z',
    });
    assert.deepEqual(wrongTarget, { status: 'blocked', reason: 'rollback_target_mismatch' });

    const rollback = await ctx.receipts.recordRollback({
      proposalId: ctx.proposed.proposalId,
      interventionReceiptRef: changed.receiptRef,
      restoredVersionRef: targetVersionRef,
      mainCommitSha,
      loadedRuntimeRef,
      restoredAt: '2026-09-12T10:26:00.000Z',
      loadedAt: '2026-09-12T10:27:00.000Z',
    });
    assert.equal(rollback.status, 'recorded');
    assert.match(rollback.receiptRef.ownerStateRef, /^rollback:request-review-/);
    assert.equal((await ctx.ledger.read())[1].type, 'rollback_recorded');
  });
});
