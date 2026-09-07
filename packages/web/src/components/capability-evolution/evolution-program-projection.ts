import type { EvolutionAttributionExplanation } from './EvolutionAttributionPanel';
import type { EvolutionObservationView } from './EvolutionObservationPanel';

/**
 * The Program projection as it crosses the network, plus the runtime guards that decide whether a
 * response really is one.
 *
 * The surface renders owner refs it did not compute, so it has to be able to say "this payload is
 * not a projection" instead of destructuring its way into a blank panel. Kept beside the component
 * rather than inside it because these are assertions about the API contract, not about the view.
 */

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

export interface EvolutionProgramProjection {
  program: {
    programId: string;
    workspaceId: string;
    objectRef: OwnerRef;
    claimRef: OwnerRef;
    lifecycle: 'active' | 'paused' | 'needs_expert' | 'terminal';
    stage: string;
    sequence: number;
    createdAt: string;
    updatedAt: string;
  };
  drafts: {
    goal: OwnerRef;
    claim: OwnerRef;
    measurement: OwnerRef;
    economic: OwnerRef;
    roles: Record<string, OwnerRef>;
  };
  blockers: Array<{ code: string; message: string; ownerFeatureId: string; ownerStateRef?: string }>;
  nextAction: { code: string; label: string };
  observation: EvolutionObservationView;
  attribution: EvolutionAttributionExplanation | null;
  lineage: EvolutionProgramLineage;
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

function isLineage(value: unknown): value is EvolutionProgramLineage {
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

function isObservation(value: unknown): value is EvolutionObservationView {
  const candidate = record(value);
  if (!candidate || (candidate.status !== 'connected' && candidate.status !== 'insufficient')) return false;
  const trajectory = record(candidate.trajectory);
  const trigger = record(candidate.trigger);
  const proofRefs = record(candidate.evidenceProofRefs);
  return (
    Array.isArray(candidate.connectedEyes) &&
    candidate.connectedEyes.every((rawEye) => {
      const eye = record(rawEye);
      return (
        eye !== undefined &&
        typeof eye.sourceKind === 'string' &&
        isOwnerRef(eye.ownerSurfaceRef) &&
        typeof eye.joinKey === 'string' &&
        isOwnerRef(eye.namedConsumerRef) &&
        isOwnerRef(eye.instrumentationRef) &&
        typeof eye.ownerHref === 'string'
      );
    }) &&
    Array.isArray(candidate.gaps) &&
    candidate.gaps.every((rawGap) => {
      const gap = record(rawGap);
      return gap !== undefined && typeof gap.code === 'string' && typeof gap.message === 'string';
    }) &&
    (candidate.trajectory === undefined ||
      (trajectory !== undefined &&
        isOwnerRef(trajectory.ref) &&
        typeof trajectory.invocationId === 'string' &&
        typeof trajectory.threadId === 'string')) &&
    (candidate.trigger === undefined ||
      (trigger !== undefined &&
        isOwnerRef(trigger.registrationRef) &&
        Array.isArray(trigger.channels) &&
        trigger.channels.every((channel) => typeof channel === 'string'))) &&
    (candidate.evidenceProofRefs === undefined ||
      (proofRefs !== undefined && Object.values(proofRefs).every(isOwnerRef))) &&
    (candidate.nextEvaluationAt === undefined || typeof candidate.nextEvaluationAt === 'string')
  );
}

export function isProjection(value: unknown): value is EvolutionProgramProjection {
  if (!value || typeof value !== 'object') return false;
  const projection = value as {
    program?: { programId?: unknown };
    blockers?: unknown;
    nextAction?: unknown;
    observation?: unknown;
    lineage?: unknown;
  };
  return (
    typeof projection.program?.programId === 'string' &&
    Array.isArray(projection.blockers) &&
    typeof projection.nextAction === 'object' &&
    isObservation(projection.observation) &&
    isLineage(projection.lineage)
  );
}
