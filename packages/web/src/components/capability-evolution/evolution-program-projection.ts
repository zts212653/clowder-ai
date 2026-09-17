import {
  type EvolutionCycleV1,
  type EvolutionProgramOriginV1,
  type EvolutionProgramV1,
  evolutionProgramOriginV1Schema,
  evolutionProgramStateV1Schema,
} from '@cat-cafe/shared';
import type { EvolutionAttributionExplanation } from './EvolutionAttributionPanel';
import type { EvolutionObservationView } from './EvolutionObservationPanel';
import { isAttribution } from './evolution-attribution-validation';
import { type EvolutionProgramLineage, isLineage, isOwnerRef, type OwnerRef } from './evolution-lineage';
import {
  type EvolutionPreparationProjection,
  parseEvolutionPreparationProjection,
} from './preparation/evolution-preparation-resource';

export {
  type EvolutionChangeLineage,
  type EvolutionChangeStatus,
  type EvolutionProgramLineage,
  type ExactAssetVersionRef,
  isOwnerRef,
  type OwnerRef,
} from './evolution-lineage';

/** A single owner read model. Missing owner projections remain distinguishable from empty records. */
export interface EvolutionProgramProjection {
  program: EvolutionProgramV1;
  origin?: EvolutionProgramOriginV1;
  cycles: EvolutionCycleV1[];
  drafts?: {
    goal: OwnerRef;
    claim?: OwnerRef;
    measurement: OwnerRef;
    economic: OwnerRef;
    roles: Record<string, OwnerRef>;
  };
  blockers: Array<{ code: string; message: string; ownerFeatureId: string; ownerStateRef?: string }>;
  nextAction: { code: string; label: string };
  observation?: EvolutionObservationView;
  attribution?: EvolutionAttributionExplanation | null;
  lineage?: EvolutionProgramLineage;
  preparation?: EvolutionPreparationProjection;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
      return (
        gap !== undefined &&
        typeof gap.code === 'string' &&
        typeof gap.message === 'string' &&
        typeof gap.ownerFeatureId === 'string' &&
        (gap.ownerStateRef === undefined || typeof gap.ownerStateRef === 'string')
      );
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

export function parseProgramProjection(value: unknown): EvolutionProgramProjection | null {
  const source = record(value);
  if (!source) return null;
  const state = evolutionProgramStateV1Schema.safeParse({ program: source.program, cycles: source.cycles });
  if (!state.success || !/^evolution-program:[0-9a-f]{32}$/.test(state.data.program.programId)) return null;
  if (!Array.isArray(source.blockers) || !source.blockers.every(isBlocker)) return null;
  const nextAction = record(source.nextAction);
  if (!nextAction || typeof nextAction.code !== 'string' || typeof nextAction.label !== 'string') return null;
  if (source.lineage !== undefined && !isLineage(source.lineage)) return null;
  if (source.observation !== undefined && !isObservation(source.observation)) return null;
  if (source.attribution !== undefined && source.attribution !== null && !isAttribution(source.attribution))
    return null;
  if (source.drafts !== undefined && !isDrafts(source.drafts)) return null;
  const origin = evolutionProgramOriginV1Schema.optional().safeParse(source.origin);
  if (!origin.success) return null;
  const preparation =
    source.preparation === undefined
      ? undefined
      : parseEvolutionPreparationProjection(source.preparation, state.data.program.programId);
  if (source.preparation !== undefined && !preparation) return null;
  return {
    ...state.data,
    ...(origin.data ? { origin: origin.data } : {}),
    blockers: source.blockers,
    nextAction: { code: nextAction.code, label: nextAction.label },
    ...(isLineage(source.lineage) ? { lineage: source.lineage } : {}),
    ...(isObservation(source.observation) ? { observation: source.observation } : {}),
    ...(source.attribution === null || isAttribution(source.attribution) ? { attribution: source.attribution } : {}),
    ...(isDrafts(source.drafts) ? { drafts: source.drafts } : {}),
    ...(preparation ? { preparation } : {}),
  };
}
function isBlocker(value: unknown): value is EvolutionProgramProjection['blockers'][number] {
  const blocker = record(value);
  return (
    !!blocker &&
    typeof blocker.code === 'string' &&
    typeof blocker.message === 'string' &&
    typeof blocker.ownerFeatureId === 'string' &&
    (blocker.ownerStateRef === undefined || typeof blocker.ownerStateRef === 'string')
  );
}
function isDrafts(value: unknown): value is NonNullable<EvolutionProgramProjection['drafts']> {
  const drafts = record(value);
  const roles = record(drafts?.roles);
  return (
    !!drafts &&
    !!roles &&
    isOwnerRef(drafts.goal) &&
    isOwnerRef(drafts.measurement) &&
    isOwnerRef(drafts.economic) &&
    (drafts.claim === undefined || isOwnerRef(drafts.claim)) &&
    Object.values(roles).every(isOwnerRef)
  );
}
export function isProjection(value: unknown): value is EvolutionProgramProjection {
  const parsed = parseProgramProjection(value);
  return parsed !== null && parsed.lineage !== undefined;
}
