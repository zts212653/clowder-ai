import type { OwnerTruthRefV1 } from '@cat-cafe/shared';
import type { ExactAssetVersionRefV1 } from '../change/program-lineage.js';
import type {
  MicroduckShowMediaAsset,
  MicroduckShowMediaDescriptor,
  MicroduckShowState,
} from './microduck-show-contract.js';

export * from './microduck-show-contract.js';

export const MICRODUCK_OWNER_FEATURE_ID = 'microduck-owner';

export const MICRODUCK_BLOCK_CODES = [
  'owner_route_unavailable',
  'permission_missing',
  'target_drift',
  'job_failed',
  'verification_missing',
  'holdout_incomplete',
  'holdout_failed',
  'holdout_leakage',
  'multiple_variables',
  'artifact_hash_mismatch',
  'approval_missing',
  'writeback_failed',
  'fresh_outcome_missing',
  'rollback_failed',
  'show_truth_incomplete',
  'preparation_media_unavailable',
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
  referenceFreshOutcomeRef?: OwnerTruthRefV1;
  clientMessageId: string;
};

export interface MicroduckObservation {
  status: 'observed';
  targetVersionRef: ExactAssetVersionRefV1;
  baselineVersionRef: ExactAssetVersionRefV1;
  observationRefs: OwnerTruthRefV1[];
  baselineArtifactSha256?: string;
  sceneMedia?: MicroduckShowMediaDescriptor[];
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
  restoreOutcomeRef?: OwnerTruthRefV1;
}

export interface MicroduckRestoreOutcome {
  status: 'restore_verified';
  outcomeReceiptRef: OwnerTruthRefV1;
  freshnessProofRef: OwnerTruthRefV1;
  restoredVersionRef: ExactAssetVersionRefV1;
  restoredArtifactSha256: string;
  measuredAt: string;
}

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
      referenceFreshOutcomeRef?: OwnerTruthRefV1;
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
