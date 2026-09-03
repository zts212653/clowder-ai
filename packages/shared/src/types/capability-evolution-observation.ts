import { z } from 'zod';
import { ownerTruthRefV1Schema } from './capability-evolution-refs.js';

const bounded = (max: number) => z.string().trim().min(1).max(max);
const canonicalJoinKeySchema = bounded(500).regex(
  /^(?:thread|message|subject):[^\s{}[\]"']+$/,
  'join keys must use a canonical thread/message/subject coordinate',
);

export const evolutionTrajectoryBindingV1Schema = z
  .object({
    ref: ownerTruthRefV1Schema,
    joinKey: canonicalJoinKeySchema.regex(/^thread:/, 'trajectory joins must use thread:<id>'),
  })
  .strict();

export const evolutionOwnerSurfaceBindingV1Schema = z
  .object({
    sourceKind: bounded(120).regex(/^[a-z0-9][a-z0-9-]*$/),
    ownerSurfaceRef: ownerTruthRefV1Schema,
    joinKey: canonicalJoinKeySchema,
    namedConsumerRef: ownerTruthRefV1Schema,
    instrumentationRef: ownerTruthRefV1Schema,
  })
  .strict();

export const evolutionEvidenceProofRefsV1Schema = z
  .object({
    decisionProofRef: ownerTruthRefV1Schema,
    evidenceRoleRef: ownerTruthRefV1Schema,
    consumptionProofRef: ownerTruthRefV1Schema,
    optimizerExposureProofRef: ownerTruthRefV1Schema,
    promotionHoldoutRef: ownerTruthRefV1Schema,
  })
  .strict();

export const evolutionObservationSetupV1Schema = z
  .object({
    trajectory: evolutionTrajectoryBindingV1Schema,
    sourceBindings: z.array(evolutionOwnerSurfaceBindingV1Schema).min(2).max(128),
    evidenceProofRefs: evolutionEvidenceProofRefsV1Schema,
    triggerRef: ownerTruthRefV1Schema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.sourceBindings.map((binding) => binding.sourceKind)).size < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceBindings'],
        message: 'observation requires at least two heterogeneous owner surfaces',
      });
    }
  });

export type EvolutionTrajectoryBindingV1 = z.infer<typeof evolutionTrajectoryBindingV1Schema>;
export type EvolutionOwnerSurfaceBindingV1 = z.infer<typeof evolutionOwnerSurfaceBindingV1Schema>;
export type EvolutionEvidenceProofRefsV1 = z.infer<typeof evolutionEvidenceProofRefsV1Schema>;
export type EvolutionObservationSetupV1 = z.infer<typeof evolutionObservationSetupV1Schema>;
