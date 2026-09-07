import type { OwnerTruthRefV1 } from '@cat-cafe/shared';
import type { ExactAssetVersionRefV1 } from '../change/program-lineage.js';
import type { MicroduckShowMediaAsset, MicroduckShowMediaDescriptor } from './microduck-show-media-contract.js';

export type {
  MicroduckShowMediaAsset,
  MicroduckShowMediaContentType,
  MicroduckShowMediaDescriptor,
  MicroduckShowMediaKind,
  MicroduckShowMediaSource,
} from './microduck-show-media-contract.js';

export const MICRODUCK_OWNER_FEATURE_ID = 'microduck-owner';

export const MICRODUCK_BLOCK_CODES = [
  'owner_route_unavailable',
  'permission_missing',
  'target_drift',
  'job_failed',
  'verification_missing',
  'holdout_incomplete',
  'holdout_leakage',
  'multiple_variables',
  'artifact_hash_mismatch',
  'approval_missing',
  'writeback_failed',
  'fresh_outcome_missing',
  'rollback_failed',
  'show_truth_incomplete',
] as const;

export type MicroduckBlockCode = (typeof MICRODUCK_BLOCK_CODES)[number];

export interface MicroduckBlocked {
  status: 'blocked';
  code: MicroduckBlockCode;
  blockerRef?: OwnerTruthRefV1;
  recoveryRef?: OwnerTruthRefV1;
}

export interface MicroduckProgramScope {
  programRef: OwnerTruthRefV1;
  cycleRef: OwnerTruthRefV1;
  objectRef: OwnerTruthRefV1;
}

export type MicroduckMutationInput = MicroduckProgramScope & {
  targetVersionRef: ExactAssetVersionRefV1;
  permissionRef: OwnerTruthRefV1;
  interventionRef: OwnerTruthRefV1;
  clientMessageId: string;
};

export type MicroduckVerificationInput = MicroduckProgramScope & {
  candidateVersionRef: ExactAssetVersionRefV1;
  evaluationReceiptRef: OwnerTruthRefV1;
  artifactSha256: string;
};

export type MicroduckWritebackInput = MicroduckProgramScope & {
  targetVersionRef: ExactAssetVersionRefV1;
  candidateVersionRef: ExactAssetVersionRefV1;
  proposalRef: OwnerTruthRefV1;
  interventionRef: OwnerTruthRefV1;
  permissionRef: OwnerTruthRefV1;
  verificationReceiptRef: OwnerTruthRefV1;
  approvalRef: OwnerTruthRefV1;
  clientMessageId: string;
};

export type MicroduckFreshOutcomeInput = MicroduckProgramScope & {
  deployedVersionRef: ExactAssetVersionRefV1;
  writebackReceiptRef: OwnerTruthRefV1;
  expectedArtifactSha256: string;
};

export type MicroduckRollbackInput = MicroduckProgramScope & {
  targetVersionRef: ExactAssetVersionRefV1;
  deployedVersionRef?: ExactAssetVersionRefV1;
  rollbackVersionRef: ExactAssetVersionRefV1;
  permissionRef: OwnerTruthRefV1;
  writebackReceiptRef?: OwnerTruthRefV1;
  clientMessageId: string;
};

export interface MicroduckObservation {
  status: 'observed';
  targetVersionRef: ExactAssetVersionRefV1;
  baselineVersionRef: ExactAssetVersionRefV1;
  observationRefs: OwnerTruthRefV1[];
}

export interface MicroduckPermission {
  status: 'authorized';
  permissionRef: OwnerTruthRefV1;
  targetVersionRef: ExactAssetVersionRefV1;
}

export interface MicroduckMutationAccepted {
  status: 'accepted';
  mutationReceiptRef: OwnerTruthRefV1;
  candidateVersionRef: ExactAssetVersionRefV1;
}

export interface MicroduckVerification {
  status: 'verified';
  evaluationReceiptRef: OwnerTruthRefV1;
  verificationReceiptRef: OwnerTruthRefV1;
  candidateVersionRef: ExactAssetVersionRefV1;
  evaluatedArtifactSha256: string;
  publicEvaluationComplete: boolean;
  holdoutEvaluationComplete: boolean;
  holdoutSealed: boolean;
  holdoutSealedProofRef: OwnerTruthRefV1;
  holdoutOptimizerExposed: boolean;
  optimizerExposureProofRef: OwnerTruthRefV1;
  singleVariable: boolean;
}

export interface MicroduckWritebackReceipt {
  status: 'deployed';
  writebackReceiptRef: OwnerTruthRefV1;
  deployedVersionRef: ExactAssetVersionRefV1;
  rollbackVersionRef: ExactAssetVersionRefV1;
  deployedArtifactSha256: string;
  deployedAt: string;
}

export interface MicroduckFreshOutcome {
  status: 'fresh';
  outcomeReceiptRef: OwnerTruthRefV1;
  freshnessProofRef: OwnerTruthRefV1;
  deployedVersionRef: ExactAssetVersionRefV1;
  deployedArtifactSha256: string;
  measuredAt: string;
}

export interface MicroduckRollbackReceipt {
  status: 'rolled_back';
  rollbackReceiptRef: OwnerTruthRefV1;
  restoredVersionRef: ExactAssetVersionRefV1;
}

export const MICRODUCK_SHOW_CANDIDATE_SUBJECTS = ['push-range', 'spawn-tilt', 'upright-weight'] as const;

export interface MicroduckShowCandidate {
  subjectId: (typeof MICRODUCK_SHOW_CANDIDATE_SUBJECTS)[number];
  policyRevision: ExactAssetVersionRefV1;
  evaluationRef: OwnerTruthRefV1;
  recipeSha256: string;
  jobRef: OwnerTruthRefV1;
  checkpointRef: OwnerTruthRefV1;
  onnxArtifactRef: OwnerTruthRefV1;
}

export const MICRODUCK_SHOW_REJECTION_KINDS = [
  'holdout_failed',
  'holdout_leakage',
  'multiple_variables',
  'artifact_hash_mismatch',
  'target_drift',
  'permission_missing',
  'not_reproducible',
] as const;

export type MicroduckShowRejectionKind = (typeof MICRODUCK_SHOW_REJECTION_KINDS)[number];

interface MicroduckShowEvidence {
  status: 'resolved';
  baseline: {
    policyRevision: ExactAssetVersionRefV1;
    captureRef: OwnerTruthRefV1;
    evaluationRef: OwnerTruthRefV1;
  };
  holdoutProof: {
    sealedProofRef: OwnerTruthRefV1;
    optimizerExposureProofRef: OwnerTruthRefV1;
    optimizerExposed: false;
  };
  candidates: MicroduckShowCandidate[];
  candidateRevision: ExactAssetVersionRefV1;
  targetRevision: ExactAssetVersionRefV1;
  rollbackRevision: ExactAssetVersionRefV1;
  approvalProposalRef: OwnerTruthRefV1;
  interventionRef: OwnerTruthRefV1;
  rejection: { kind: MicroduckShowRejectionKind; ownerRef: OwnerTruthRefV1 };
  evaluatedArtifactSha256: string;
  sceneMedia?: MicroduckShowMediaDescriptor[];
}

export type MicroduckShowState =
  | (MicroduckShowEvidence & { phase: 'approval_ready' })
  | (MicroduckShowEvidence & { phase: 'applying'; approvalRef: OwnerTruthRefV1 })
  | (MicroduckShowEvidence & {
      phase: 'verifying';
      approvalRef: OwnerTruthRefV1;
      deployedRevision: ExactAssetVersionRefV1;
      deployedArtifactSha256: string;
    })
  | (MicroduckShowEvidence & {
      phase: 'kept';
      approvalRef: OwnerTruthRefV1;
      deployedRevision: ExactAssetVersionRefV1;
      deployedArtifactSha256: string;
      freshOutcomeRef: OwnerTruthRefV1;
    })
  | (MicroduckShowEvidence & {
      phase: 'rolled_back';
      approvalRef: OwnerTruthRefV1;
      deployedRevision: ExactAssetVersionRefV1;
      deployedArtifactSha256: string;
      rollbackReceiptRef: OwnerTruthRefV1;
    });

/** Secret-bearing clients live behind these implementations; neither result admits a credential. */
export interface MicroduckCredentialBoundary {
  authorize(
    input: MicroduckProgramScope & {
      targetVersionRef: ExactAssetVersionRefV1;
      permissionRef: OwnerTruthRefV1;
      operation: 'mutate' | 'writeback' | 'rollback';
    },
  ): Promise<MicroduckPermission | MicroduckBlocked>;
}

export interface MicroduckApprovalResolver {
  resolve(input: { proposalRef: OwnerTruthRefV1 }): Promise<
    | {
        status: 'approved';
        approvalRef: OwnerTruthRefV1;
        proposalRef: OwnerTruthRefV1;
        programRef: OwnerTruthRefV1;
        cycleRef: OwnerTruthRefV1;
        interventionRef: OwnerTruthRefV1;
        targetVersionRef: ExactAssetVersionRefV1;
      }
    | MicroduckBlocked
  >;
}

export interface MicroduckProposalResolver {
  resolve(input: { proposalRef: OwnerTruthRefV1 }): Promise<
    | {
        status: 'pending';
        proposalRef: OwnerTruthRefV1;
        programRef: OwnerTruthRefV1;
        cycleRef: OwnerTruthRefV1;
        interventionRef: OwnerTruthRefV1;
        targetVersionRef: ExactAssetVersionRefV1;
      }
    | MicroduckBlocked
  >;
}

export interface MicroduckOwnerPort {
  observe(input: MicroduckProgramScope): Promise<MicroduckObservation | MicroduckBlocked>;
  launchMutation(
    input: MicroduckProgramScope & {
      targetVersionRef: ExactAssetVersionRefV1;
      permissionRef: OwnerTruthRefV1;
      interventionRef: OwnerTruthRefV1;
      clientMessageId: string;
    },
  ): Promise<MicroduckMutationAccepted | MicroduckBlocked>;
  resolveVerification(
    input: MicroduckProgramScope & {
      candidateVersionRef: ExactAssetVersionRefV1;
      evaluationReceiptRef?: OwnerTruthRefV1;
      verificationReceiptRef?: OwnerTruthRefV1;
    },
  ): Promise<MicroduckVerification | MicroduckBlocked>;
  writeback(
    input: MicroduckProgramScope & {
      targetVersionRef: ExactAssetVersionRefV1;
      candidateVersionRef: ExactAssetVersionRefV1;
      proposalRef: OwnerTruthRefV1;
      interventionRef: OwnerTruthRefV1;
      permissionRef: OwnerTruthRefV1;
      verificationReceiptRef: OwnerTruthRefV1;
      approvalRef: OwnerTruthRefV1;
      clientMessageId: string;
    },
  ): Promise<MicroduckWritebackReceipt | MicroduckBlocked>;
  collectFreshOutcome(
    input: MicroduckProgramScope & {
      deployedVersionRef: ExactAssetVersionRefV1;
      writebackReceiptRef: OwnerTruthRefV1;
    },
  ): Promise<MicroduckFreshOutcome | MicroduckBlocked>;
  rollback(
    input: MicroduckProgramScope & {
      targetVersionRef: ExactAssetVersionRefV1;
      deployedVersionRef?: ExactAssetVersionRefV1;
      rollbackVersionRef: ExactAssetVersionRefV1;
      permissionRef: OwnerTruthRefV1;
      writebackReceiptRef?: OwnerTruthRefV1;
      clientMessageId: string;
    },
  ): Promise<MicroduckRollbackReceipt | MicroduckBlocked>;
  resolveShowState(
    input: MicroduckProgramScope & { programSequence: number },
  ): Promise<MicroduckShowState | MicroduckBlocked>;
  resolveShowMedia?(
    input: MicroduckProgramScope & {
      programSequence: number;
      sceneIndex: number;
      captureRef: OwnerTruthRefV1;
    },
  ): Promise<MicroduckShowMediaAsset | MicroduckBlocked>;
}

export interface MicroduckShowManifestV1 {
  manifestVersion: 'f311-microduck-show-v1';
  tier: 'A' | 'B';
  phase: MicroduckShowState['phase'] | 'blocked';
  actionState: 'enabled' | 'disabled';
  programRef: OwnerTruthRefV1;
  programSequence: number;
  baseline?: MicroduckShowEvidence['baseline'];
  holdoutProof?: MicroduckShowEvidence['holdoutProof'];
  candidates: MicroduckShowCandidate[];
  candidateRevision?: ExactAssetVersionRefV1;
  targetRevision?: ExactAssetVersionRefV1;
  rollbackRevision?: ExactAssetVersionRefV1;
  approvalProposalRef?: OwnerTruthRefV1;
  approvalRef?: OwnerTruthRefV1;
  rejection?: MicroduckShowEvidence['rejection'];
  interventionRef?: OwnerTruthRefV1;
  sceneMedia?: Array<
    MicroduckShowMediaDescriptor & {
      assetUrl: string;
    }
  >;
  deployedRevision?: ExactAssetVersionRefV1;
  evaluatedArtifactHash?: string;
  deployedArtifactHash?: string;
  freshOutcomeRef?: OwnerTruthRefV1;
  rollbackReceiptRef?: OwnerTruthRefV1;
  blockers?: Array<{ code: MicroduckBlockCode; ownerRef?: OwnerTruthRefV1 }>;
  action?: {
    kind: 'f246-approval';
    method: 'POST';
    approvalUrl: string;
    body: { reasonCode: 'accepted_as_proposed' };
  };
  generatedAt: string;
}
