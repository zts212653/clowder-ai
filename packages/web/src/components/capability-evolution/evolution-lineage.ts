export interface OwnerRef {
  ownerFeatureId: string;
  ownerStateRef: string;
  version?: string;
}

export interface ExactAssetVersionRef extends OwnerRef {
  version: string;
  assetKind: string;
  assetId: string;
}

export type EvolutionChangeStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'withdrawn'
  | 'superseded'
  | 'target_drift'
  | 'changed'
  | 'no_change'
  | 'outcome';

export interface EvolutionChangeLineage {
  caseRef: OwnerRef;
  proposalRef: OwnerRef;
  ownerAuthorizationRef: OwnerRef;
  targetVersionRef: ExactAssetVersionRef;
  status: EvolutionChangeStatus;
  approvalRef?: OwnerRef;
  approvalDecisionRef?: OwnerRef;
  interventionKind?: 'changed' | 'no_change';
  interventionReceiptRef?: OwnerRef;
  assetVersionRef?: ExactAssetVersionRef;
  outcomeReceiptRef?: OwnerRef;
  loadedRuntimeRef?: OwnerRef;
  freshnessProofRef?: OwnerRef;
}

export interface EvolutionProgramLineage {
  cycles: Array<{
    cycle: number;
    changes: EvolutionChangeLineage[];
    decision?: 'keep' | 'tune' | 'rollback' | 'sunset' | 'no_change';
    decisionRef?: OwnerRef;
    executionReceiptRef?: OwnerRef;
    decisionAssetVersionRef?: ExactAssetVersionRef;
  }>;
  current?: EvolutionChangeLineage;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function isOwnerRef(value: unknown): value is OwnerRef {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    typeof candidate.ownerFeatureId === 'string' &&
    typeof candidate.ownerStateRef === 'string' &&
    (candidate.version === undefined || typeof candidate.version === 'string')
  );
}

function isExactAssetVersionRef(value: unknown): value is ExactAssetVersionRef {
  const candidate = record(value);
  return (
    isOwnerRef(value) &&
    typeof candidate?.version === 'string' &&
    typeof candidate.assetKind === 'string' &&
    typeof candidate.assetId === 'string'
  );
}

const isOptionalOwnerRef = (value: unknown): boolean => value === undefined || isOwnerRef(value);
const isOptionalExactAssetVersionRef = (value: unknown): boolean =>
  value === undefined || isExactAssetVersionRef(value);

function isChange(value: unknown): value is EvolutionChangeLineage {
  const candidate = record(value);
  if (
    candidate === undefined ||
    !isOwnerRef(candidate.caseRef) ||
    !isOwnerRef(candidate.proposalRef) ||
    !isOwnerRef(candidate.ownerAuthorizationRef) ||
    !isExactAssetVersionRef(candidate.targetVersionRef) ||
    ![
      'pending',
      'approved',
      'rejected',
      'withdrawn',
      'superseded',
      'target_drift',
      'changed',
      'no_change',
      'outcome',
    ].includes(String(candidate.status)) ||
    !isOptionalOwnerRef(candidate.approvalRef) ||
    !isOptionalOwnerRef(candidate.approvalDecisionRef) ||
    (candidate.interventionKind !== undefined &&
      candidate.interventionKind !== 'changed' &&
      candidate.interventionKind !== 'no_change') ||
    !isOptionalOwnerRef(candidate.interventionReceiptRef) ||
    !isOptionalExactAssetVersionRef(candidate.assetVersionRef) ||
    !isOptionalOwnerRef(candidate.outcomeReceiptRef) ||
    !isOptionalOwnerRef(candidate.loadedRuntimeRef) ||
    !isOptionalOwnerRef(candidate.freshnessProofRef)
  ) {
    return false;
  }
  if (candidate.status === 'approved') return isOwnerRef(candidate.approvalRef);
  if (['rejected', 'withdrawn', 'superseded', 'target_drift'].includes(String(candidate.status))) {
    return isOwnerRef(candidate.approvalDecisionRef);
  }
  if (candidate.status === 'changed' || candidate.status === 'no_change') {
    return (
      candidate.interventionKind === candidate.status &&
      isOwnerRef(candidate.interventionReceiptRef) &&
      isExactAssetVersionRef(candidate.assetVersionRef) &&
      (candidate.status === 'changed'
        ? isOwnerRef(candidate.loadedRuntimeRef)
        : candidate.loadedRuntimeRef === undefined)
    );
  }
  if (candidate.status === 'outcome') {
    return (
      isOwnerRef(candidate.approvalRef) &&
      (candidate.interventionKind === 'changed' || candidate.interventionKind === 'no_change') &&
      isOwnerRef(candidate.interventionReceiptRef) &&
      isExactAssetVersionRef(candidate.assetVersionRef) &&
      isOwnerRef(candidate.outcomeReceiptRef) &&
      (candidate.interventionKind === 'changed'
        ? isOwnerRef(candidate.loadedRuntimeRef)
        : candidate.loadedRuntimeRef === undefined) &&
      isOwnerRef(candidate.freshnessProofRef)
    );
  }
  return true;
}

export function isLineage(value: unknown): value is EvolutionProgramLineage {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    Array.isArray(candidate.cycles) &&
    candidate.cycles.every((value) => {
      const cycle = record(value);
      return (
        cycle !== undefined &&
        typeof cycle.cycle === 'number' &&
        Array.isArray(cycle.changes) &&
        cycle.changes.every(isChange) &&
        (cycle.decision === undefined ||
          ['keep', 'tune', 'rollback', 'sunset', 'no_change'].includes(String(cycle.decision))) &&
        isOptionalOwnerRef(cycle.decisionRef) &&
        isOptionalOwnerRef(cycle.executionReceiptRef) &&
        isOptionalExactAssetVersionRef(cycle.decisionAssetVersionRef) &&
        (cycle.decision === undefined || isOwnerRef(cycle.decisionRef)) &&
        (cycle.decision !== 'rollback' || isOwnerRef(cycle.executionReceiptRef)) &&
        (cycle.decision !== 'sunset' || isOwnerRef(cycle.executionReceiptRef)) &&
        (cycle.decision !== 'no_change' || isOwnerRef(cycle.executionReceiptRef)) &&
        ((cycle.decision !== 'rollback' && cycle.decision !== 'no_change') ||
          isExactAssetVersionRef(cycle.decisionAssetVersionRef))
      );
    }) &&
    (candidate.current === undefined || isChange(candidate.current))
  );
}
