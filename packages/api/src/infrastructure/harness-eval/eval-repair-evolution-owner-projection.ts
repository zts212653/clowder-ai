import {
  type ExactAssetVersionRefV1,
  exactAssetVersionRefV1Schema,
  type OwnerTruthRefV1,
  ownerTruthRefV1Schema,
  refIdentity,
} from '@cat-cafe/shared';
import type { EvalRepairApprovalRecord } from './eval-repair-approval-projection.js';
import { projectEvalRepairApprovals } from './eval-repair-approval-projection.js';
import { evalRepairCaseRef, evalRepairProposalRef } from './eval-repair-outcome-refs.js';
import type { EvalLifecycleEvent } from './reeval-closure-schema.js';

export interface EvalRepairEvolutionSnapshot {
  status:
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'withdrawn'
    | 'superseded'
    | 'target_drift'
    | 'mutated'
    | 'no_change'
    | 'outcome';
  caseRef: OwnerTruthRefV1;
  proposalRef: OwnerTruthRefV1;
  ownerAuthorizationRef: OwnerTruthRefV1;
  targetVersionRef: ExactAssetVersionRefV1;
  approvalRef?: OwnerTruthRefV1;
  decisionRef?: OwnerTruthRefV1;
  interventionReceiptRef?: OwnerTruthRefV1;
  assetVersionRef?: ExactAssetVersionRefV1;
  loadedRuntimeRef?: OwnerTruthRefV1;
  outcomeReceiptRef?: OwnerTruthRefV1;
  freshnessProofRef?: OwnerTruthRefV1;
  changedAt?: string;
  recordedAt?: string;
  loadedAt?: string;
  measuredAt?: string;
}

export function sameRef(left: unknown, right: unknown): boolean {
  try {
    return refIdentity(left as never) === refIdentity(right as never);
  } catch {
    return false;
  }
}

export function proposalIdFromRef(ref: OwnerTruthRefV1): string | undefined {
  const prefix = 'eval-repair-proposal:';
  return ref.ownerFeatureId === 'F266' && ref.ownerStateRef.startsWith(prefix)
    ? ref.ownerStateRef.slice(prefix.length) || undefined
    : undefined;
}

export function projectEvalRepairEvolutionSnapshot(
  events: readonly EvalLifecycleEvent[],
  proposalId: string,
): EvalRepairEvolutionSnapshot {
  const approval = projectEvalRepairApprovals(events).proposals.find(
    (candidate) => candidate.proposal.proposalId === proposalId,
  );
  if (!approval) throw new Error('F266 owner snapshot proposal missing');
  const changed = [...events]
    .reverse()
    .find(
      (event) =>
        (event.type === 'repair_intervention_changed' || event.type === 'repair_intervention_no_change') &&
        event.proposalId === proposalId,
    );
  const outcome = [...events]
    .reverse()
    .find((event) => event.type === 'repair_outcome_recorded' && event.proposalId === proposalId);
  const status = snapshotStatus(approval, changed, outcome);
  return {
    status,
    caseRef: evalRepairCaseRef(approval.proposal.caseId, approval.proposal.verdictId),
    proposalRef: evalRepairProposalRef(proposalId),
    ownerAuthorizationRef: approval.proposal.requestSnapshot.ownerAuthorizationRef,
    targetVersionRef: approval.proposal.requestSnapshot.targetVersionRef,
    ...(approval.approvalRef ? { approvalRef: approval.approvalRef } : {}),
    ...decisionSnapshotFields(approval, status),
    ...interventionSnapshotFields(changed),
    ...outcomeSnapshotFields(outcome),
  };
}

function decisionSnapshotFields(approval: EvalRepairApprovalRecord, status: EvalRepairEvolutionSnapshot['status']) {
  if ((status === 'rejected' || status === 'withdrawn') && approval.approvalRef) {
    return { decisionRef: approval.approvalRef };
  }
  if ((status === 'superseded' || status === 'target_drift') && approval.supersessionDecisionRef) {
    return { decisionRef: approval.supersessionDecisionRef };
  }
  return {};
}

function snapshotStatus(
  approval: EvalRepairApprovalRecord,
  intervention: EvalLifecycleEvent | undefined,
  outcome: EvalLifecycleEvent | undefined,
): EvalRepairEvolutionSnapshot['status'] {
  if (outcome?.type === 'repair_outcome_recorded') return 'outcome';
  if (intervention?.type === 'repair_intervention_changed') return 'mutated';
  if (intervention?.type === 'repair_intervention_no_change') return 'no_change';
  if (approval.supersededByCaseActionRef) {
    return approval.supersessionDrift === 'target' ? 'target_drift' : 'superseded';
  }
  if (approval.lifecycle.resolution === 'accepted') return 'approved';
  if (approval.lifecycle.resolution === 'rejected') return 'rejected';
  if (approval.lifecycle.resolution === 'closed_without_decision') return 'withdrawn';
  return 'pending';
}

function interventionSnapshotFields(intervention: EvalLifecycleEvent | undefined) {
  if (intervention?.type !== 'repair_intervention_changed' && intervention?.type !== 'repair_intervention_no_change') {
    return {};
  }
  const base = { interventionReceiptRef: intervention.interventionReceiptRef };
  if (intervention.type === 'repair_intervention_no_change') {
    return { ...base, recordedAt: intervention.recordedAt };
  }
  return {
    ...base,
    assetVersionRef: intervention.assetVersionRef,
    loadedRuntimeRef: intervention.loadedRuntimeRef,
    changedAt: intervention.changedAt,
    loadedAt: intervention.loadedAt,
  };
}

function outcomeSnapshotFields(outcome: EvalLifecycleEvent | undefined) {
  if (outcome?.type !== 'repair_outcome_recorded') return {};
  return {
    outcomeReceiptRef: outcome.outcomeReceiptRef,
    freshnessProofRef: outcome.freshnessProofRef,
    ...(outcome.loadedRuntimeRef ? { loadedRuntimeRef: outcome.loadedRuntimeRef } : {}),
    measuredAt: outcome.measuredAt,
  };
}

export interface MetabolismDecisionEventInput {
  programRef: OwnerTruthRefV1;
  cycleRef: OwnerTruthRefV1;
  caseRef: OwnerTruthRefV1;
  proposalRef: OwnerTruthRefV1;
  outcomeReceiptRef: OwnerTruthRefV1;
  decision: 'keep' | 'tune' | 'rollback' | 'sunset' | 'no_change';
  clientMessageId: string;
  decisionAuthority: unknown;
}

export interface MetabolismDecisionOwnerReceipt {
  status: 'recorded' | 'duplicate';
  decisionRef: OwnerTruthRefV1;
  executionReceiptRef?: OwnerTruthRefV1;
  assetVersionRef?: ExactAssetVersionRefV1;
}

export function buildMetabolismDecisionEvent(
  proposal: Extract<EvalLifecycleEvent, { type: 'approval_proposed' }>,
  eventId: string,
  input: MetabolismDecisionEventInput,
  authorityRef: OwnerTruthRefV1,
  result: MetabolismDecisionOwnerReceipt,
  occurredAt: string,
): Extract<EvalLifecycleEvent, { type: 'repair_metabolism_decided' }> {
  if (!proposal.ownerLineage) throw new Error('value decision requires owner lineage');
  return {
    eventId,
    caseId: proposal.caseId,
    verdictId: proposal.verdictId,
    domainId: proposal.domainId,
    type: 'repair_metabolism_decided',
    actor: { kind: 'automation', id: 'eval-repair-evolution-owner-port' },
    occurredAt,
    reason: 'verified owner value authority recorded one ref-only metabolism decision',
    refs: [{ kind: 'other', availability: 'available', value: result.decisionRef.ownerStateRef }],
    proposalId: proposal.proposalId,
    ownerLineage: proposal.ownerLineage,
    outcomeReceiptRef: input.outcomeReceiptRef,
    decision: input.decision,
    decisionAuthorityRef: ownerTruthRefV1Schema.parse(authorityRef),
    decisionRef: ownerTruthRefV1Schema.parse(result.decisionRef),
    ...(result.executionReceiptRef
      ? { executionReceiptRef: ownerTruthRefV1Schema.parse(result.executionReceiptRef) }
      : {}),
    ...(result.assetVersionRef ? { assetVersionRef: exactAssetVersionRefV1Schema.parse(result.assetVersionRef) } : {}),
  };
}

export function metabolismDecisionResult(
  status: 'recorded' | 'duplicate',
  event: Extract<EvalLifecycleEvent, { type: 'repair_metabolism_decided' }>,
) {
  return {
    status,
    decisionRef: event.decisionRef,
    ...(event.executionReceiptRef ? { executionReceiptRef: event.executionReceiptRef } : {}),
    ...(event.assetVersionRef ? { assetVersionRef: event.assetVersionRef } : {}),
  };
}
