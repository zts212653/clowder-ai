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
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isOwnerRef(value: unknown): value is OwnerRef {
  const candidate = record(value);
  return (
    candidate !== undefined &&
    typeof candidate.ownerFeatureId === 'string' &&
    typeof candidate.ownerStateRef === 'string' &&
    (candidate.version === undefined || typeof candidate.version === 'string')
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
  };
  return (
    typeof projection.program?.programId === 'string' &&
    Array.isArray(projection.blockers) &&
    typeof projection.nextAction === 'object' &&
    isObservation(projection.observation)
  );
}
