import { z } from 'zod';
import type { UnifiedAwaitStateV1, WaitOutcomeBaseV1, WaitOutcomeDelivery } from './wait-contract.js';

export type DeploymentSubjectRef = `deployment:${string}:${string}`;
export type DeploymentService = 'api' | 'web';

const fullRevision = z.string().regex(/^[0-9a-f]{40}$/);
const services = z
  .array(z.enum(['api', 'web']))
  .min(1)
  .max(2)
  .refine((items) => new Set(items).size === items.length, 'services must be unique');

export const deploymentSubjectRefSchema = z.string().regex(/^deployment:[a-z0-9-]+:[a-z][a-z0-9._-]{0,63}$/);
export const deploymentWaitPredicateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('revision_included'), revision: fullRevision, services }).strict(),
  z.object({ kind: z.literal('new_ready_boot'), services }).strict(),
]);

export type DeploymentWaitPredicate =
  | {
      readonly kind: 'revision_included';
      /** Frozen merge/build revision; never a mutable PR head. */
      readonly revision: string;
      readonly services: readonly DeploymentService[];
    }
  | {
      readonly kind: 'new_ready_boot';
      readonly services: readonly DeploymentService[];
    };

export interface DeploymentWaitBaseline {
  /** Assigned by the deployment ledger, independent of wall clock. */
  readonly bootSequence: number;
  readonly bootId: string;
  readonly capturedAt: number;
}

export type DeploymentAwaitStateV1 = UnifiedAwaitStateV1<
  DeploymentSubjectRef,
  DeploymentWaitBaseline,
  DeploymentWaitPredicate
> & { readonly autoRenew: false };

export interface DeploymentInclusionProofV1 {
  readonly kind: 'git_ancestry' | 'build_manifest';
  readonly targetRevision: string;
  readonly runningRevision: string;
  readonly included: boolean;
}

export interface DeploymentObservationV1 {
  readonly subjectRef: DeploymentSubjectRef;
  readonly bootId: string;
  readonly bootSequence: number;
  readonly runningRevision: string | null;
  readonly readyServices: readonly DeploymentService[];
  readonly observedAt: number;
  readonly inclusionProof?: DeploymentInclusionProofV1;
}

export interface DeploymentWaitMatchedEvidenceV1 {
  readonly kind: DeploymentWaitPredicate['kind'];
  readonly services: readonly DeploymentService[];
  readonly targetRevision?: string;
  readonly bootId: string;
  readonly bootSequence: number;
  readonly runningRevision: string | null;
  readonly observedAt: number;
  readonly proofKind?: DeploymentInclusionProofV1['kind'];
}

/** Deployment-only outcome variant; GitHub deltas cannot be stored here. */
export interface DeploymentWaitOutcomeV1 extends WaitOutcomeBaseV1<DeploymentSubjectRef> {
  readonly domain: 'deployment';
  /** Original registration time retained after the active await is consumed. */
  readonly registeredAt?: number;
  readonly deploymentMatch?: DeploymentWaitMatchedEvidenceV1;
  readonly matched?: never;
  readonly terminalSubjectState?: never;
  readonly renewal?: never;
}

export interface DeploymentWaitStateV1 {
  readonly await?: DeploymentAwaitStateV1;
  readonly waitOutcome?: DeploymentWaitOutcomeV1;
  /** Registration's existing owner turn holds first-consumer priority until its callback settles. */
  readonly currentExecutionClaim?: {
    readonly invocationId: string;
    readonly generation: number;
    readonly bootId: string;
  };
}

export type DeploymentWaitProjectionState = 'waiting_for_update' | 'ready_to_return' | 'unknown';

export type DeploymentWaitProjectionStateReason =
  | 'deployment_evidence_unavailable'
  | 'deployment_evidence_incomplete'
  | 'deployment_match_pending_recheck';

export interface DeploymentWaitObservationProjection {
  readonly bootId: string;
  readonly bootSequence: number;
  readonly runningRevision: string | null;
  readonly readyServices: readonly DeploymentService[];
  readonly observedAt: number;
}

/** Read-only Hub projection. Task and deployment owners remain the only writers. */
export interface DeploymentWaitItemProjection {
  readonly taskId: string;
  readonly threadId: string;
  readonly threadTitle: string | null;
  readonly taskTitle: string;
  readonly ownerCatId: string | null;
  readonly sourceMessageId?: string;
  readonly subjectRef: DeploymentSubjectRef;
  readonly deploymentId: string;
  readonly generation: number;
  readonly createdAt: number | null;
  /** Frozen when the deployment match was persisted, so ready rows stop accruing wait time. */
  readonly matchedAt?: number;
  readonly nextStep: string;
  readonly condition: DeploymentWaitPredicate;
  readonly state: DeploymentWaitProjectionState;
  readonly stateReason?: DeploymentWaitProjectionStateReason;
  readonly delivery?: WaitOutcomeDelivery;
  readonly observation?: DeploymentWaitObservationProjection;
}

export interface DeploymentCandidateProjection {
  readonly revision: string;
  readonly observedAt: number;
  readonly satisfiableCount: number;
  readonly unknownCount: number;
}

export interface DeploymentWaitListResponse {
  readonly projectPath: string;
  readonly items: readonly DeploymentWaitItemProjection[];
  readonly candidate: DeploymentCandidateProjection | null;
}

export type DeploymentWaitEvaluation =
  | {
      readonly state: 'matched';
      readonly matched: DeploymentWaitMatchedEvidenceV1;
    }
  | { readonly state: 'waiting' | 'unknown' };

function matched(
  predicate: DeploymentWaitPredicate,
  observation: DeploymentObservationV1,
  proofKind?: DeploymentInclusionProofV1['kind'],
): DeploymentWaitEvaluation {
  return {
    state: 'matched',
    matched: {
      kind: predicate.kind,
      services: predicate.services,
      ...(predicate.kind === 'revision_included' ? { targetRevision: predicate.revision } : {}),
      bootId: observation.bootId,
      bootSequence: observation.bootSequence,
      runningRevision: observation.runningRevision,
      observedAt: observation.observedAt,
      ...(proofKind ? { proofKind } : {}),
    },
  };
}

function evaluateBoot(
  active: DeploymentAwaitStateV1,
  predicate: Extract<DeploymentWaitPredicate, { kind: 'new_ready_boot' }>,
  observation: DeploymentObservationV1,
): DeploymentWaitEvaluation {
  const baseline = active.baseline;
  if (!Number.isSafeInteger(baseline.bootSequence) || baseline.bootSequence < 0 || !baseline.bootId) {
    return { state: 'unknown' };
  }
  if (observation.bootSequence <= baseline.bootSequence) return { state: 'waiting' };
  if (observation.bootId === baseline.bootId) return { state: 'unknown' };
  return matched(predicate, observation);
}

function evaluateRevision(
  predicate: Extract<DeploymentWaitPredicate, { kind: 'revision_included' }>,
  observation: DeploymentObservationV1,
): DeploymentWaitEvaluation {
  const proof = observation.inclusionProof;
  if (!fullRevision.safeParse(predicate.revision).success || !observation.runningRevision || !proof) {
    return { state: 'unknown' };
  }
  if (proof.targetRevision !== predicate.revision || proof.runningRevision !== observation.runningRevision) {
    return { state: 'unknown' };
  }
  return proof.included ? matched(predicate, observation, proof.kind) : { state: 'waiting' };
}

export function evaluateDeploymentWait(
  active: DeploymentAwaitStateV1,
  observation: DeploymentObservationV1,
): DeploymentWaitEvaluation {
  if (active.subjectRef !== observation.subjectRef) return { state: 'waiting' };
  if (
    active.autoRenew !== false ||
    active.continuation.when.length !== 1 ||
    !Number.isSafeInteger(observation.bootSequence) ||
    observation.bootSequence < 0 ||
    !observation.bootId
  ) {
    return { state: 'unknown' };
  }

  const predicate = active.continuation.when[0];
  if (!predicate || predicate.services.length === 0) return { state: 'unknown' };
  if (!predicate.services.every((service) => observation.readyServices.includes(service))) {
    return { state: 'waiting' };
  }

  return predicate.kind === 'new_ready_boot'
    ? evaluateBoot(active, predicate, observation)
    : evaluateRevision(predicate, observation);
}

/** Recheck a consumed match against the deployment immediately before durable owner delivery. */
export function deploymentOutcomeMatchesObservation(
  outcome: DeploymentWaitOutcomeV1,
  observation: DeploymentObservationV1,
): boolean {
  const evidence = outcome.deploymentMatch;
  if (!evidence || outcome.subjectRef !== observation.subjectRef) return false;
  if (!evidence.services.every((service) => observation.readyServices.includes(service))) return false;
  if (evidence.kind === 'new_ready_boot') {
    return (
      observation.bootSequence > evidence.bootSequence ||
      (observation.bootSequence === evidence.bootSequence && observation.bootId === evidence.bootId)
    );
  }
  const proof = observation.inclusionProof;
  return (
    !!evidence.targetRevision &&
    !!observation.runningRevision &&
    !!proof?.included &&
    proof.targetRevision === evidence.targetRevision &&
    proof.runningRevision === observation.runningRevision
  );
}
