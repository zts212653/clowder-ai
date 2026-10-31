import type {
  AssetVersionRefV1,
  EvolutionCycleDecision,
  EvolutionProgramEventEnvelopeV1,
  EvolutionProgramEventV1,
  OwnerTruthRefV1,
} from '@cat-cafe/shared';

export type ExactAssetVersionRefV1 = AssetVersionRefV1 & { version: string };

export interface EvolutionChangeLineageV1 {
  caseRef: OwnerTruthRefV1;
  proposalRef: OwnerTruthRefV1;
  ownerAuthorizationRef: OwnerTruthRefV1;
  targetVersionRef: ExactAssetVersionRefV1;
  status:
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'withdrawn'
    | 'superseded'
    | 'target_drift'
    | 'changed'
    | 'no_change'
    | 'outcome';
  approvalRef?: OwnerTruthRefV1;
  approvalDecisionRef?: OwnerTruthRefV1;
  interventionKind?: 'changed' | 'no_change';
  interventionReceiptRef?: OwnerTruthRefV1;
  assetVersionRef?: ExactAssetVersionRefV1;
  outcomeReceiptRef?: OwnerTruthRefV1;
  loadedRuntimeRef?: OwnerTruthRefV1;
  freshnessProofRef?: OwnerTruthRefV1;
}

export interface EvolutionCycleLineageV1 {
  cycle: number;
  changes: EvolutionChangeLineageV1[];
  decision?: EvolutionCycleDecision;
  decisionRef?: OwnerTruthRefV1;
  executionReceiptRef?: OwnerTruthRefV1;
  decisionAssetVersionRef?: ExactAssetVersionRefV1;
}

export interface EvolutionProgramLineageV1 {
  cycles: EvolutionCycleLineageV1[];
  current?: EvolutionChangeLineageV1;
}

function applyChangeProgress(current: EvolutionChangeLineageV1, event: EvolutionProgramEventV1): void {
  switch (event.type) {
    case 'approval_linked':
      current.approvalRef = event.approvalRef;
      current.status = 'approved';
      break;
    case 'approval_rejected_or_superseded':
      current.approvalDecisionRef = event.decisionRef;
      current.status = event.result;
      break;
    case 'intervention_receipt_linked':
      current.interventionKind = event.result;
      current.interventionReceiptRef = event.interventionReceiptRef;
      current.assetVersionRef = event.assetVersionRef;
      current.loadedRuntimeRef = event.loadedRuntimeRef;
      current.status = event.result;
      break;
    case 'outcome_linked':
      current.outcomeReceiptRef = event.outcomeReceiptRef;
      current.freshnessProofRef = event.freshnessProofRef;
      current.status = 'outcome';
      break;
    default:
      break;
  }
}

function recordCycleDecision(cycle: EvolutionCycleLineageV1, event: EvolutionProgramEventV1): boolean {
  if (event.type !== 'decision_recorded') return false;
  cycle.decision = event.decision;
  cycle.decisionRef = event.decisionRef;
  cycle.executionReceiptRef = event.executionReceiptRef;
  cycle.decisionAssetVersionRef = event.assetVersionRef;
  return event.decision === 'tune' || event.decision === 'rollback';
}

/**
 * Ref-only causal projection. Business payloads and canonical lifecycle state remain in F246/F266
 * and the asset owner; this view is rebuilt from the Program event stream on every read.
 */
export function projectEvolutionProgramLineage(
  events: readonly EvolutionProgramEventEnvelopeV1[],
): EvolutionProgramLineageV1 {
  const cycles: EvolutionCycleLineageV1[] = [{ cycle: 1, changes: [] }];
  let cycle = cycles[0];
  let current: EvolutionChangeLineageV1 | undefined;

  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === 'change_cycle_linked') {
      current = {
        caseRef: event.caseRef,
        proposalRef: event.proposalRef,
        ownerAuthorizationRef: event.ownerAuthorizationRef,
        targetVersionRef: event.targetVersionRef,
        status: 'pending',
      };
      cycle.changes.push(current);
      continue;
    }
    if (recordCycleDecision(cycle, event)) {
      cycle = { cycle: cycle.cycle + 1, changes: [] };
      cycles.push(cycle);
      current = undefined;
      continue;
    }
    if (current) applyChangeProgress(current, event);
  }
  return { cycles, ...(current === undefined ? {} : { current }) };
}
