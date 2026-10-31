import type { ExactAssetVersionRefV1, OwnerTruthRefV1 } from '@cat-cafe/shared';
import type { EvalReleaseTruthResolver } from './eval-release-truth-resolver.js';
import type { EvalRepairApprovalServiceOptions, EvalRepairOwnerLineage } from './eval-repair-approval-contracts.js';
import type { IReevalClosureEventLog } from './reeval-closure-event-log.js';

export interface EvalRepairBoundRefs {
  caseRef: OwnerTruthRefV1;
  proposalRef: OwnerTruthRefV1;
  approvalRef: OwnerTruthRefV1;
  ownerAuthorizationRef: OwnerTruthRefV1;
  targetVersionRef: ExactAssetVersionRefV1;
  interventionRef: OwnerTruthRefV1;
}

export interface EvalRepairChangedReceipt extends EvalRepairBoundRefs {
  kind: 'changed';
  receiptRef: OwnerTruthRefV1;
  assetVersionRef: ExactAssetVersionRefV1;
  mainCommitSha: string;
  loadedRuntimeRef: OwnerTruthRefV1;
  changedAt: string;
  loadedAt: string;
}

export interface EvalRepairNoChangeReceipt extends EvalRepairBoundRefs {
  kind: 'no_change';
  receiptRef: OwnerTruthRefV1;
  reasonCode: 'evidence_already_satisfied' | 'risk_exceeds_benefit' | 'target_retired' | 'blocked_external' | 'other';
  withdrawalCondition: string;
  nextEvalAt: string;
  recordedAt: string;
}

export type EvalRepairInterventionReceipt = EvalRepairChangedReceipt | EvalRepairNoChangeReceipt;

export interface EvalRepairFreshOutcomeReceipt extends EvalRepairBoundRefs {
  receiptRef: OwnerTruthRefV1;
  interventionReceiptRef: OwnerTruthRefV1;
  reevaluationRef: OwnerTruthRefV1;
  freshnessProofRef: OwnerTruthRefV1;
  outcome: 'effective_keep' | 'ineffective_tune' | 'ineffective_rollback' | 'rubric_reopen' | 'insufficient_observe';
  loadedRuntimeRef?: OwnerTruthRefV1;
  measuredAt: string;
  uncontaminated: boolean;
}

export interface EvalRepairOutcomeInput extends EvalRepairBoundRefs {
  interventionReceiptRef: OwnerTruthRefV1;
  outcomeReceiptRef: OwnerTruthRefV1;
}

export type EvalRepairOutcomeBlockReason =
  | 'proposal_not_found'
  | 'binding_missing'
  | 'case_mismatch'
  | 'proposal_mismatch'
  | 'approval_mismatch'
  | 'authorization_mismatch'
  | 'target_mismatch'
  | 'intervention_mismatch'
  | 'approval_not_accepted'
  | 'approval_not_materialized'
  | 'approval_superseded'
  | 'case_action_not_found'
  | 'owner_receipt_not_found'
  | 'owner_receipt_mismatch'
  | 'main_not_landed'
  | 'live_not_active'
  | 'loaded_runtime_mismatch'
  | 'invalid_receipt_time'
  | 'intervention_receipt_missing'
  | 'outcome_receipt_not_found'
  | 'outcome_receipt_mismatch'
  | 'stale_outcome'
  | 'preload_outcome'
  | 'contaminated_outcome'
  | 'idempotency_collision'
  | 'owner_unresolved'
  | 'owner_ambiguous'
  | 'owner_authorization_missing'
  | 'owner_authorization_unreadable'
  | 'owner_authorization_expired'
  | 'owner_authorization_target_mismatch'
  | 'target_version_mismatch';

export type EvalRepairOutcomeCommandResult =
  | { status: 'recorded' | 'duplicate'; kind: 'changed' | 'no_change' }
  | { status: 'recorded' | 'duplicate'; outcome: EvalRepairFreshOutcomeReceipt['outcome'] }
  | {
      status: 'blocked';
      reason: EvalRepairOutcomeBlockReason;
      drift?: 'owner' | 'authorization' | 'target';
      freshCaseActionRef?: string;
    };

export interface EvalRepairOutcomeServiceOptions {
  eventLog: IReevalClosureEventLog;
  resolveCaseAction: EvalRepairApprovalServiceOptions['resolveCaseAction'];
  resolveOwnerChangeContract: EvalRepairApprovalServiceOptions['resolveOwnerChangeContract'];
  interventionReceiptOwner: {
    resolve(receiptRef: OwnerTruthRefV1): Promise<EvalRepairInterventionReceipt | null>;
  };
  freshOutcomeOwner: {
    resolve(receiptRef: OwnerTruthRefV1): Promise<EvalRepairFreshOutcomeReceipt | null>;
  };
  releaseTruth: Pick<EvalReleaseTruthResolver, 'loadedRuntimeHead' | 'verifyMainLanded' | 'verifyLiveActive'>;
  now?: () => string;
}

export interface EvalRepairOwnerChangeProjection {
  caseRef: OwnerTruthRefV1;
  proposalRef: OwnerTruthRefV1;
  approvalRef: OwnerTruthRefV1;
  ownerAuthorizationRef: OwnerTruthRefV1;
  targetVersionRef: ExactAssetVersionRefV1;
  ownerLineage: EvalRepairOwnerLineage;
  intervention?: {
    kind: 'changed' | 'no_change';
    receiptRef: OwnerTruthRefV1;
    assetVersionRef?: ExactAssetVersionRefV1;
    mainCommitSha?: string;
    loadedRuntimeRef?: OwnerTruthRefV1;
    changedAt?: string;
    loadedAt?: string;
    reasonCode?: EvalRepairNoChangeReceipt['reasonCode'];
    withdrawalCondition?: string;
    nextEvalAt?: string;
    recordedAt?: string;
  };
  outcome?: {
    outcomeReceiptRef: OwnerTruthRefV1;
    reevaluationRef: OwnerTruthRefV1;
    freshnessProofRef: OwnerTruthRefV1;
    outcome: EvalRepairFreshOutcomeReceipt['outcome'];
    loadedRuntimeRef?: OwnerTruthRefV1;
    measuredAt: string;
  };
}
