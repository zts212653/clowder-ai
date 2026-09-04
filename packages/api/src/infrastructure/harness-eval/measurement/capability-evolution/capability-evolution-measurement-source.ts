import { ownerTruthRefV1Schema } from '@cat-cafe/shared';
import { z } from 'zod';

import { MeasurementBundleCertificateSchema, MeasurementBundleResultSchema } from '../measurement-bundle-schema.js';
import { MeasurementDecisionProofOwnerObjectSchema } from '../measurement-decision-proof-owner-object.js';
import { MeasurementDecisionProofCandidateSchema } from '../measurement-decision-proof-schema.js';

const nonEmpty = z.string().trim().min(1);
const featureId = z.string().regex(/^F\d{3}$/);
const fullRevision = z.string().regex(/^[a-f0-9]{40}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256');
const safeId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/);

const ownerObject = z
  .object({
    ref: nonEmpty,
    artifact: MeasurementDecisionProofOwnerObjectSchema,
  })
  .strict();

export const CapabilityEvolutionMeasurementSourceSchema = z
  .object({
    kind: z.literal('f267-capability-evolution-measurement-source'),
    schemaVersion: z.literal(1),
    sourceId: safeId,
    ownerUserId: nonEmpty,
    ownerFeatureId: featureId,
    generatedAt: z.string().datetime(),
    sourceRevision: fullRevision,
    sourceArtifacts: z
      .array(
        z
          .object({
            ownerFeatureId: featureId,
            ref: nonEmpty,
            sha256,
          })
          .strict(),
      )
      .min(1)
      .max(64),
    program: z
      .object({
        programId: z.string().regex(/^evolution-program:[a-f0-9]{32}$/),
        expectedSequence: z.number().int().nonnegative(),
        targetRef: ownerTruthRefV1Schema,
        claimRef: ownerTruthRefV1Schema,
      })
      .strict(),
    roles: z
      .object({
        observer: ownerTruthRefV1Schema,
        domainOwner: ownerTruthRefV1Schema,
        consumer: ownerTruthRefV1Schema,
        calibrator: ownerTruthRefV1Schema,
        overlapJustification: nonEmpty.optional(),
      })
      .strict(),
    certificate: MeasurementBundleCertificateSchema,
    result: MeasurementBundleResultSchema,
    decisionProof: MeasurementDecisionProofCandidateSchema,
    ownerObjects: z.array(ownerObject).max(16),
  })
  .strict();

export const CapabilityEvolutionMeasurementRoleBindingSchema = z
  .object({
    kind: z.literal('f267-capability-evolution-measurement-role'),
    schemaVersion: z.literal(1),
    programId: z.string().regex(/^evolution-program:[a-f0-9]{32}$/),
    proofRef: nonEmpty,
    role: z.enum(['observer', 'domain_owner', 'consumer', 'calibrator']),
    occupantRef: ownerTruthRefV1Schema,
    ownerUserId: nonEmpty,
    generatedAt: z.string().datetime(),
    source: z
      .object({
        ownerFeatureId: featureId,
        ownerStateRef: nonEmpty,
        artifactRef: nonEmpty,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();

export type CapabilityEvolutionMeasurementSource = z.infer<typeof CapabilityEvolutionMeasurementSourceSchema>;
export type CapabilityEvolutionMeasurementRoleBinding = z.infer<typeof CapabilityEvolutionMeasurementRoleBindingSchema>;
