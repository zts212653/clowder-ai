import { exactAssetVersionRefV1Schema, ownerTruthRefV1Schema } from '@cat-cafe/shared';
import { z } from 'zod';
import {
  MICRODUCK_BLOCK_CODES,
  MICRODUCK_CONTROL_SHOW_CANDIDATE_SUBJECTS,
  MICRODUCK_SHOW_CANDIDATE_SUBJECTS,
  MICRODUCK_SHOW_REJECTION_KINDS,
  type MicroduckShowState,
} from './microduck-owner-contract.js';
import { MICRODUCK_SHOW_MEDIA_CONTENT_TYPES } from './microduck-show-media-contract.js';

const timestamp = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i);
const lowercaseSha256 = z.string().regex(/^[a-f0-9]{64}$/u);

const showMediaDescriptorSchema = z
  .object({
    sceneIndex: z.number().int().min(0).max(7),
    source: z.enum(['real_capture', 'faithful_replay']),
    captureRef: ownerTruthRefV1Schema,
    kind: z.enum(['image', 'video']),
  })
  .strict();

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
    baselineArtifactSha256: lowercaseSha256.optional(),
    sceneMedia: z.array(showMediaDescriptorSchema).max(8).optional(),
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
    restoreOutcomeRef: ownerTruthRefV1Schema.optional(),
  })
  .strict();

export const microduckRestoreOutcomeSchema = z
  .object({
    status: z.literal('restore_verified'),
    outcomeReceiptRef: ownerTruthRefV1Schema,
    freshnessProofRef: ownerTruthRefV1Schema,
    restoredVersionRef: exactAssetVersionRefV1Schema,
    restoredArtifactSha256: sha256,
    measuredAt: timestamp,
  })
  .strict();

const trainingShowCandidateSchema = z
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

const controlShowCandidateSchema = z
  .object({
    subjectId: z.enum(MICRODUCK_CONTROL_SHOW_CANDIDATE_SUBJECTS),
    policyRevision: exactAssetVersionRefV1Schema,
    artifactRevision: exactAssetVersionRefV1Schema,
    configRef: ownerTruthRefV1Schema,
    runnerRef: ownerTruthRefV1Schema,
    evaluationEnvRef: ownerTruthRefV1Schema,
    evaluationRef: ownerTruthRefV1Schema,
  })
  .strict();

const showEvidenceCommon = {
  status: z.literal('resolved'),
  holdoutProof: z
    .object({
      sealedProofRef: ownerTruthRefV1Schema,
      optimizerExposureProofRef: ownerTruthRefV1Schema,
      optimizerExposed: z.literal(false),
    })
    .strict(),
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
  sceneMedia: z.array(showMediaDescriptorSchema).max(8).optional(),
};

const trainingShowEvidenceSchema = z
  .object({
    ...showEvidenceCommon,
    interventionKind: z.literal('training'),
    baseline: z
      .object({
        policyRevision: exactAssetVersionRefV1Schema,
        captureRef: ownerTruthRefV1Schema,
        evaluationRef: ownerTruthRefV1Schema,
      })
      .strict(),
    candidates: z.array(trainingShowCandidateSchema).length(3),
  })
  .strict();

const controlShowEvidenceSchema = z
  .object({
    ...showEvidenceCommon,
    interventionKind: z.literal('control_config'),
    baseline: z
      .object({
        policyRevision: exactAssetVersionRefV1Schema,
        artifactRevision: exactAssetVersionRefV1Schema,
        configRef: ownerTruthRefV1Schema,
        runnerRef: ownerTruthRefV1Schema,
        evaluationEnvRef: ownerTruthRefV1Schema,
        captureRef: ownerTruthRefV1Schema,
        evaluationRef: ownerTruthRefV1Schema,
      })
      .strict(),
    candidates: z.array(controlShowCandidateSchema).length(3),
  })
  .strict();

function showStateSchemaFor<
  Evidence extends typeof trainingShowEvidenceSchema | typeof controlShowEvidenceSchema,
  RolledBackFields extends z.ZodRawShape,
>(evidence: Evidence, rolledBackFields: RolledBackFields) {
  const deploying = evidence.extend({
    approvalRef: ownerTruthRefV1Schema,
    deployedRevision: exactAssetVersionRefV1Schema,
    deployedArtifactSha256: sha256,
  });
  const rolledBack = deploying.extend({
    phase: z.literal('rolled_back'),
    rollbackReceiptRef: ownerTruthRefV1Schema,
    ...rolledBackFields,
  });
  return z.discriminatedUnion('phase', [
    evidence.extend({ phase: z.literal('approval_ready') }),
    evidence.extend({ phase: z.literal('applying'), approvalRef: ownerTruthRefV1Schema }),
    deploying.extend({ phase: z.literal('verifying') }),
    deploying.extend({ phase: z.literal('kept'), freshOutcomeRef: ownerTruthRefV1Schema }),
    rolledBack,
  ]);
}

export const microduckShowStateSchema = z.union([
  showStateSchemaFor(trainingShowEvidenceSchema, {}),
  showStateSchemaFor(controlShowEvidenceSchema, { restoreOutcomeRef: ownerTruthRefV1Schema }),
]) as z.ZodType<MicroduckShowState>;

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
