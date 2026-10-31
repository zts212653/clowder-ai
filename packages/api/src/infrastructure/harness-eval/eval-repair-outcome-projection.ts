import { projectEvalRepairApprovals } from './eval-repair-approval-projection.js';
import type { EvalRepairOwnerChangeProjection } from './eval-repair-outcome-contracts.js';
import { evalRepairCaseRef, evalRepairProposalRef } from './eval-repair-outcome-refs.js';
import type { EvalLifecycleEvent } from './reeval-closure-schema.js';

export function projectEvalRepairOutcome(
  events: readonly EvalLifecycleEvent[],
  proposalId: string,
): EvalRepairOwnerChangeProjection {
  const approval = projectEvalRepairApprovals(events).proposals.find(
    (candidate) => candidate.proposal.proposalId === proposalId,
  );
  if (!approval) throw new Error(`eval repair proposal not found: ${proposalId}`);
  if (!approval.approvalRef) throw new Error(`eval repair Approval is undecided: ${proposalId}`);
  if (!approval.proposal.ownerLineage) throw new Error(`eval repair owner lineage is missing: ${proposalId}`);
  const projection: EvalRepairOwnerChangeProjection = {
    caseRef: evalRepairCaseRef(approval.proposal.caseId, approval.proposal.verdictId),
    proposalRef: evalRepairProposalRef(proposalId),
    approvalRef: approval.approvalRef,
    ownerAuthorizationRef: approval.proposal.requestSnapshot.ownerAuthorizationRef,
    targetVersionRef: approval.proposal.requestSnapshot.targetVersionRef,
    ownerLineage: approval.proposal.ownerLineage,
  };
  for (const event of events) {
    if (!('proposalId' in event) || event.proposalId !== proposalId) continue;
    applyPhaseDEvent(projection, event);
  }
  return projection;
}

function applyPhaseDEvent(projection: EvalRepairOwnerChangeProjection, event: EvalLifecycleEvent): void {
  if (event.type === 'repair_intervention_changed') {
    projection.intervention = {
      kind: 'changed',
      receiptRef: event.interventionReceiptRef,
      assetVersionRef: event.assetVersionRef,
      mainCommitSha: event.mainCommitSha,
      loadedRuntimeRef: event.loadedRuntimeRef,
      changedAt: event.changedAt,
      loadedAt: event.loadedAt,
    };
  } else if (event.type === 'repair_intervention_no_change') {
    projection.intervention = {
      kind: 'no_change',
      receiptRef: event.interventionReceiptRef,
      reasonCode: event.reasonCode,
      withdrawalCondition: event.withdrawalCondition,
      nextEvalAt: event.nextEvalAt,
      recordedAt: event.recordedAt,
    };
  } else if (event.type === 'repair_outcome_recorded') {
    projection.outcome = {
      outcomeReceiptRef: event.outcomeReceiptRef,
      reevaluationRef: event.reevaluationRef,
      freshnessProofRef: event.freshnessProofRef,
      outcome: event.outcome,
      ...(event.loadedRuntimeRef ? { loadedRuntimeRef: event.loadedRuntimeRef } : {}),
      measuredAt: event.measuredAt,
    };
  }
}
