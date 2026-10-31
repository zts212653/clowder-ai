import {
  type EvolutionEvidenceProofRefsV1,
  type EvolutionObservationSetupV1,
  type EvolutionOwnerSurfaceBindingV1,
  evolutionEvidenceProofRefsV1Schema,
  evolutionOwnerSurfaceBindingV1Schema,
  type OwnerTruthRefV1,
  ownerTruthRefV1Schema,
} from '@cat-cafe/shared';
import { z } from 'zod';

const trajectoryRefSchema = ownerTruthRefV1Schema.superRefine((value, ctx) => {
  if (value.ownerFeatureId !== 'F299' || !/^inv:[^\s:]+$/.test(value.ownerStateRef)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'trajectory must use the canonical F299 inv:<id> ref' });
  }
});
const joinInputSchema = z
  .object({
    programId: z.string().regex(/^evolution-program:[a-z0-9-]+$/),
    ownerUserId: z.string().trim().min(1).max(240),
    trajectoryRef: ownerTruthRefV1Schema,
    sourceBindings: z.array(evolutionOwnerSurfaceBindingV1Schema).min(1).max(128),
    evidenceProofRef: ownerTruthRefV1Schema,
  })
  .strict();

export type ProgramObservationBlockerCode =
  | 'trajectory_unresolved'
  | 'heterogeneous_owner_surfaces_missing'
  | 'owner_surface_resolver_missing'
  | 'owner_surface_unresolved'
  | 'owner_surface_unavailable'
  | 'trigger_registration_missing'
  | 'named_consumer_missing'
  | 'instrumentation_proposal_invalid'
  | 'evidence_owner_contract_unavailable'
  | 'evidence_role_missing'
  | 'consumption_proof_missing'
  | 'optimizer_exposure_proof_missing'
  | 'promotion_holdout_missing'
  | 'promotion_holdout_reuses_evaluation_cohort'
  | 'promotion_holdout_optimizer_exposed'
  | 'promotion_holdout_not_sealed'
  | 'promotion_holdout_not_time_fresh';

export interface ProgramObservationBlocker {
  code: ProgramObservationBlockerCode;
  ownerFeatureId: string;
  ownerStateRef?: string;
}

export class ProgramJoinInputError extends Error {
  constructor(
    readonly code: 'trajectory_ref_invalid' | 'join_input_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'ProgramJoinInputError';
  }
}

interface TrajectoryResolverResult {
  status: 'resolved' | 'missing';
  invocationId?: string;
  threadId?: string;
  sessionId?: string;
}
export interface OwnerSurfaceResolverResult {
  status: 'resolved' | 'missing';
}
export type ProgramOwnerSurfaceResolver = (input: {
  ownerUserId: string;
  ownerSurfaceRef: OwnerTruthRefV1;
  joinKey: string;
  instrumentationRef: OwnerTruthRefV1;
}) => Promise<OwnerSurfaceResolverResult>;
type EvidenceResolverResult =
  | { status: 'verified'; proofRefs: EvolutionEvidenceProofRefsV1 }
  | { status: 'insufficient'; blockers: ProgramObservationBlocker[] };

export interface ProgramJoinValidatorOptions {
  trajectoryResolver: (input: { ownerUserId: string; invocationId: string }) => Promise<TrajectoryResolverResult>;
  sourceResolvers: Record<string, ProgramOwnerSurfaceResolver | undefined>;
  evidenceProofResolver?: (input: {
    ownerUserId: string;
    evidenceProofRef: OwnerTruthRefV1;
    sourceBindings: EvolutionOwnerSurfaceBindingV1[];
  }) => Promise<EvidenceResolverResult>;
}

export type ProgramJoinValidationResult =
  | { status: 'ready'; setup: Omit<EvolutionObservationSetupV1, 'triggerRef'> }
  | { status: 'insufficient'; blockers: ProgramObservationBlocker[] };

function hasHeterogeneousOwnerSurfaces(bindings: EvolutionOwnerSurfaceBindingV1[]): boolean {
  const distinctKinds = new Set(bindings.map((binding) => binding.sourceKind));
  const distinctOwners = new Set(
    bindings.map((binding) => `${binding.ownerSurfaceRef.ownerFeatureId}:${binding.ownerSurfaceRef.ownerStateRef}`),
  );
  return distinctKinds.size >= 2 && distinctOwners.size >= 2;
}

function invalidInstrumentationProposal(
  bindings: EvolutionOwnerSurfaceBindingV1[],
): EvolutionOwnerSurfaceBindingV1 | undefined {
  return bindings.find(
    (binding) =>
      binding.instrumentationRef.ownerFeatureId !== binding.ownerSurfaceRef.ownerFeatureId ||
      !binding.instrumentationRef.ownerStateRef.startsWith('instrumentation:'),
  );
}

function hasCanonicalNamedConsumers(bindings: EvolutionOwnerSurfaceBindingV1[], programId: string): boolean {
  return bindings.every(
    (binding) =>
      binding.namedConsumerRef.ownerFeatureId === 'F311' &&
      binding.namedConsumerRef.ownerStateRef === `evolution-consumer:${programId}`,
  );
}

function parseJoinInput(rawInput: unknown) {
  const rawTrajectory = z.object({ trajectoryRef: z.unknown() }).passthrough().safeParse(rawInput);
  const trajectoryRef = rawTrajectory.success
    ? trajectoryRefSchema.safeParse(rawTrajectory.data.trajectoryRef)
    : undefined;
  if (!trajectoryRef?.success) {
    throw new ProgramJoinInputError(
      'trajectory_ref_invalid',
      trajectoryRef?.error.message ?? 'trajectoryRef is required',
    );
  }
  const parsed = joinInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new ProgramJoinInputError('join_input_invalid', parsed.error.message);
  return { input: parsed.data, trajectoryRef: trajectoryRef.data };
}

export class ProgramJoinValidator {
  constructor(private readonly options: ProgramJoinValidatorOptions) {}

  async validate(rawInput: unknown): Promise<ProgramJoinValidationResult> {
    const { input, trajectoryRef } = parseJoinInput(rawInput);

    const invocationId = trajectoryRef.ownerStateRef.slice('inv:'.length);
    const trajectory = await this.options.trajectoryResolver({ ownerUserId: input.ownerUserId, invocationId });
    if (trajectory.status !== 'resolved' || trajectory.invocationId !== invocationId || !trajectory.threadId) {
      return {
        status: 'insufficient',
        blockers: [
          {
            code: 'trajectory_unresolved',
            ownerFeatureId: 'F299',
            ownerStateRef: trajectoryRef.ownerStateRef,
          },
        ],
      };
    }
    if (!hasHeterogeneousOwnerSurfaces(input.sourceBindings)) {
      return {
        status: 'insufficient',
        blockers: [
          {
            code: 'heterogeneous_owner_surfaces_missing',
            ownerFeatureId: 'F311',
          },
        ],
      };
    }
    if (!hasCanonicalNamedConsumers(input.sourceBindings, input.programId)) {
      return {
        status: 'insufficient',
        blockers: [
          {
            code: 'named_consumer_missing',
            ownerFeatureId: 'F311',
          },
        ],
      };
    }
    const invalidInstrumentation = invalidInstrumentationProposal(input.sourceBindings);
    if (invalidInstrumentation) {
      return {
        status: 'insufficient',
        blockers: [
          {
            code: 'instrumentation_proposal_invalid',
            ownerFeatureId: invalidInstrumentation.ownerSurfaceRef.ownerFeatureId,
            ownerStateRef: invalidInstrumentation.instrumentationRef.ownerStateRef,
          },
        ],
      };
    }

    const sourceBlockers = await this.resolveSources(input.ownerUserId, input.sourceBindings);
    if (sourceBlockers.length > 0) return { status: 'insufficient', blockers: sourceBlockers };
    if (!this.options.evidenceProofResolver) {
      return {
        status: 'insufficient',
        blockers: [
          {
            code: 'evidence_owner_contract_unavailable',
            ownerFeatureId: 'F267',
            ownerStateRef: input.evidenceProofRef.ownerStateRef,
          },
        ],
      };
    }
    const evidence = await this.options.evidenceProofResolver({
      ownerUserId: input.ownerUserId,
      evidenceProofRef: input.evidenceProofRef,
      sourceBindings: input.sourceBindings,
    });
    if (evidence.status === 'insufficient') return evidence;
    const proofRefs = evolutionEvidenceProofRefsV1Schema.safeParse(evidence.proofRefs);
    if (!proofRefs.success) {
      return {
        status: 'insufficient',
        blockers: [
          {
            code: 'evidence_owner_contract_unavailable',
            ownerFeatureId: 'F267',
            ownerStateRef: input.evidenceProofRef.ownerStateRef,
          },
        ],
      };
    }
    if (proofRefs.data.decisionProofRef.ownerFeatureId !== 'F267') {
      return {
        status: 'insufficient',
        blockers: [
          {
            code: 'evidence_owner_contract_unavailable',
            ownerFeatureId: 'F267',
            ownerStateRef: input.evidenceProofRef.ownerStateRef,
          },
        ],
      };
    }

    return {
      status: 'ready',
      setup: {
        trajectory: { ref: trajectoryRef, joinKey: `thread:${trajectory.threadId}` },
        sourceBindings: input.sourceBindings,
        evidenceProofRefs: proofRefs.data,
      },
    };
  }

  private async resolveSources(
    ownerUserId: string,
    bindings: EvolutionOwnerSurfaceBindingV1[],
  ): Promise<ProgramObservationBlocker[]> {
    const blockers = await Promise.all(
      bindings.map(async (binding): Promise<ProgramObservationBlocker | undefined> => {
        const resolver = this.options.sourceResolvers[binding.sourceKind];
        if (!resolver)
          return {
            code: 'owner_surface_resolver_missing',
            ownerFeatureId: binding.ownerSurfaceRef.ownerFeatureId,
            ownerStateRef: binding.ownerSurfaceRef.ownerStateRef,
          };
        try {
          const result = await resolver({
            ownerUserId,
            ownerSurfaceRef: binding.ownerSurfaceRef,
            joinKey: binding.joinKey,
            instrumentationRef: binding.instrumentationRef,
          });
          return result.status === 'resolved'
            ? undefined
            : {
                code: 'owner_surface_unresolved',
                ownerFeatureId: binding.ownerSurfaceRef.ownerFeatureId,
                ownerStateRef: binding.ownerSurfaceRef.ownerStateRef,
              };
        } catch {
          return {
            code: 'owner_surface_unavailable',
            ownerFeatureId: binding.ownerSurfaceRef.ownerFeatureId,
            ownerStateRef: binding.ownerSurfaceRef.ownerStateRef,
          };
        }
      }),
    );
    return blockers.filter((blocker): blocker is ProgramObservationBlocker => blocker !== undefined);
  }
}
