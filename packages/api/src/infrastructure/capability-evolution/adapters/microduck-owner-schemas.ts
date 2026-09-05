import { exactAssetVersionRefV1Schema, ownerTruthRefV1Schema } from '@cat-cafe/shared';
import { z } from 'zod';
import {
  MICRODUCK_BLOCK_CODES,
  MICRODUCK_SHOW_CANDIDATE_SUBJECTS,
  MICRODUCK_SHOW_REJECTION_KINDS,
} from './microduck-owner-contract.js';
import { MICRODUCK_SHOW_MEDIA_CONTENT_TYPES } from './microduck-show-media-contract.js';

const timestamp = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i);
const lowercaseSha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const microduckBlockedSchema = z
  .object({
    status: z.literal('blocked'),
    code: z.enum(MICRODUCK_BLOCK_CODES),
    blockerRef: ownerTruthRefV1Schema.optional(),
    recoveryRef: ownerTruthRefV1Schema.optional(),
  })
  .strict();

export const microduckObservationSchema = z
  .object({
    status: z.literal('observed'),
    targetVersionRef: exactAssetVersionRefV1Schema,
    baselineVersionRef: exactAssetVersionRefV1Schema,
    observationRefs: z.array(ownerTruthRefV1Schema).max(64),
  })
  .strict();

export const microduckPermissionSchema = z
  .object({
    status: z.literal('authorized'),
    permissionRef: ownerTruthRefV1Schema,
    targetVersionRef: exactAssetVersionRefV1Schema,
  })
  .strict();

export const microduckMutationSchema = z
  .object({
    status: z.literal('accepted'),
    mutationReceiptRef: ownerTruthRefV1Schema,
    candidateVersionRef: exactAssetVersionRefV1Schema,
  })
  .strict();

export const microduckVerificationSchema = z
  .object({
    status: z.literal('verified'),
    evaluationReceiptRef: ownerTruthRefV1Schema,
    verificationReceiptRef: ownerTruthRefV1Schema,
    candidateVersionRef: exactAssetVersionRefV1Schema,
    evaluatedArtifactSha256: sha256,
    publicEvaluationComplete: z.boolean(),
    holdoutEvaluationComplete: z.boolean(),
    holdoutSealed: z.boolean(),
    holdoutSealedProofRef: ownerTruthRefV1Schema,
    holdoutOptimizerExposed: z.boolean(),
    optimizerExposureProofRef: ownerTruthRefV1Schema,
    singleVariable: z.boolean(),
  })
  .strict();

export const microduckWritebackSchema = z
  .object({
    status: z.literal('deployed'),
    writebackReceiptRef: ownerTruthRefV1Schema,
    deployedVersionRef: exactAssetVersionRefV1Schema,
    rollbackVersionRef: exactAssetVersionRefV1Schema,
    deployedArtifactSha256: sha256,
    deployedAt: timestamp,
  })
  .strict();

export const microduckFreshOutcomeSchema = z
  .object({
    status: z.literal('fresh'),
    outcomeReceiptRef: ownerTruthRefV1Schema,
    freshnessProofRef: ownerTruthRefV1Schema,
    deployedVersionRef: exactAssetVersionRefV1Schema,
    deployedArtifactSha256: sha256,
    measuredAt: timestamp,
  })
  .strict();

export const microduckRollbackSchema = z
  .object({
    status: z.literal('rolled_back'),
    rollbackReceiptRef: ownerTruthRefV1Schema,
    restoredVersionRef: exactAssetVersionRefV1Schema,
  })
  .strict();

const showCandidateSchema = z
  .object({
    subjectId: z.enum(MICRODUCK_SHOW_CANDIDATE_SUBJECTS),
    policyRevision: exactAssetVersionRefV1Schema,
    evaluationRef: ownerTruthRefV1Schema,
    recipeSha256: lowercaseSha256,
    jobRef: ownerTruthRefV1Schema,
    checkpointRef: ownerTruthRefV1Schema,
    onnxArtifactRef: ownerTruthRefV1Schema,
  })
  .strict();

const showMediaDescriptorSchema = z
  .object({
    sceneIndex: z.number().int().min(1).max(7),
    source: z.enum(['real_capture', 'faithful_replay']),
    captureRef: ownerTruthRefV1Schema,
    kind: z.enum(['image', 'video']),
  })
  .strict();

const microduckShowEvidenceSchema = z
  .object({
    status: z.literal('resolved'),
    baseline: z
      .object({
        policyRevision: exactAssetVersionRefV1Schema,
        captureRef: ownerTruthRefV1Schema,
        evaluationRef: ownerTruthRefV1Schema,
      })
      .strict(),
    holdoutProof: z
      .object({
        sealedProofRef: ownerTruthRefV1Schema,
        optimizerExposureProofRef: ownerTruthRefV1Schema,
        optimizerExposed: z.literal(false),
      })
      .strict(),
    candidates: z.array(showCandidateSchema).length(3),
    candidateRevision: exactAssetVersionRefV1Schema,
    targetRevision: exactAssetVersionRefV1Schema,
    rollbackRevision: exactAssetVersionRefV1Schema,
    approvalProposalRef: ownerTruthRefV1Schema,
    interventionRef: ownerTruthRefV1Schema,
    rejection: z
      .object({
        kind: z.enum(MICRODUCK_SHOW_REJECTION_KINDS),
        ownerRef: ownerTruthRefV1Schema,
      })
      .strict(),
    evaluatedArtifactSha256: sha256,
    sceneMedia: z.array(showMediaDescriptorSchema).max(7).optional(),
  })
  .strict();

const deployingShowStateSchema = microduckShowEvidenceSchema.extend({
  approvalRef: ownerTruthRefV1Schema,
  deployedRevision: exactAssetVersionRefV1Schema,
  deployedArtifactSha256: sha256,
});

export const microduckShowStateSchema = z.discriminatedUnion('phase', [
  microduckShowEvidenceSchema.extend({ phase: z.literal('approval_ready') }),
  microduckShowEvidenceSchema.extend({
    phase: z.literal('applying'),
    approvalRef: ownerTruthRefV1Schema,
  }),
  deployingShowStateSchema.extend({ phase: z.literal('verifying') }),
  deployingShowStateSchema.extend({
    phase: z.literal('kept'),
    freshOutcomeRef: ownerTruthRefV1Schema,
  }),
  deployingShowStateSchema.extend({
    phase: z.literal('rolled_back'),
    rollbackReceiptRef: ownerTruthRefV1Schema,
  }),
]);

export const microduckApprovalSchema = z
  .object({
    status: z.literal('approved'),
    approvalRef: ownerTruthRefV1Schema,
    proposalRef: ownerTruthRefV1Schema,
    programRef: ownerTruthRefV1Schema,
    cycleRef: ownerTruthRefV1Schema,
    interventionRef: ownerTruthRefV1Schema,
    targetVersionRef: exactAssetVersionRefV1Schema,
  })
  .strict();

export const microduckProposalSchema = z
  .object({
    status: z.literal('pending'),
    proposalRef: ownerTruthRefV1Schema,
    programRef: ownerTruthRefV1Schema,
    cycleRef: ownerTruthRefV1Schema,
    interventionRef: ownerTruthRefV1Schema,
    targetVersionRef: exactAssetVersionRefV1Schema,
  })
  .strict();

export const microduckShowMediaSchema = z
  .object({
    status: z.literal('resolved'),
    captureRef: ownerTruthRefV1Schema,
    kind: z.enum(['image', 'video']),
    contentType: z.enum(MICRODUCK_SHOW_MEDIA_CONTENT_TYPES),
    bytes: z.instanceof(Uint8Array),
  })
  .strict();
