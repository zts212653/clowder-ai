import type { OwnerTruthRefV1 } from '@cat-cafe/shared';
import type { ExactAssetVersionRefV1 } from '../change/program-lineage.js';
import type { MicroduckBlockCode } from './microduck-owner-contract.js';
import type { MicroduckShowMediaDescriptor } from './microduck-show-media-contract.js';

export type {
  MicroduckShowMediaAsset,
  MicroduckShowMediaContentType,
  MicroduckShowMediaDescriptor,
  MicroduckShowMediaKind,
  MicroduckShowMediaSource,
} from './microduck-show-media-contract.js';

export const MICRODUCK_SHOW_INTERVENTION_KINDS = ['training', 'control_config'] as const;
export type MicroduckShowInterventionKind = (typeof MICRODUCK_SHOW_INTERVENTION_KINDS)[number];

export const MICRODUCK_SHOW_CANDIDATE_SUBJECTS = ['push-range', 'spawn-tilt', 'upright-weight'] as const;
export const MICRODUCK_CONTROL_SHOW_CANDIDATE_SUBJECTS = [
  'action-scale-090',
  'action-scale-105',
  'action-scale-110',
] as const;

export interface MicroduckTrainingShowCandidate {
  subjectId: (typeof MICRODUCK_SHOW_CANDIDATE_SUBJECTS)[number];
  policyRevision: ExactAssetVersionRefV1;
  evaluationRef: OwnerTruthRefV1;
  recipeSha256: string;
  jobRef: OwnerTruthRefV1;
  checkpointRef: OwnerTruthRefV1;
  onnxArtifactRef: OwnerTruthRefV1;
}

export interface MicroduckControlShowCandidate {
  subjectId: (typeof MICRODUCK_CONTROL_SHOW_CANDIDATE_SUBJECTS)[number];
  policyRevision: ExactAssetVersionRefV1;
  artifactRevision: ExactAssetVersionRefV1;
  configRef: OwnerTruthRefV1;
  runnerRef: OwnerTruthRefV1;
  evaluationEnvRef: OwnerTruthRefV1;
  evaluationRef: OwnerTruthRefV1;
}

export type MicroduckShowCandidate = MicroduckTrainingShowCandidate | MicroduckControlShowCandidate;

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

interface MicroduckShowEvidenceCommon {
  status: 'resolved';
  holdoutProof: {
    sealedProofRef: OwnerTruthRefV1;
    optimizerExposureProofRef: OwnerTruthRefV1;
    optimizerExposed: false;
  };
  candidateRevision: ExactAssetVersionRefV1;
  targetRevision: ExactAssetVersionRefV1;
  rollbackRevision: ExactAssetVersionRefV1;
  approvalProposalRef: OwnerTruthRefV1;
  interventionRef: OwnerTruthRefV1;
  rejection: { kind: MicroduckShowRejectionKind; ownerRef: OwnerTruthRefV1 };
  evaluatedArtifactSha256: string;
  sceneMedia?: MicroduckShowMediaDescriptor[];
}

export interface MicroduckTrainingShowEvidence extends MicroduckShowEvidenceCommon {
  interventionKind: 'training';
  baseline: {
    policyRevision: ExactAssetVersionRefV1;
    captureRef: OwnerTruthRefV1;
    evaluationRef: OwnerTruthRefV1;
  };
  candidates: MicroduckTrainingShowCandidate[];
}

export interface MicroduckControlShowEvidence extends MicroduckShowEvidenceCommon {
  interventionKind: 'control_config';
  baseline: {
    policyRevision: ExactAssetVersionRefV1;
    artifactRevision: ExactAssetVersionRefV1;
    configRef: OwnerTruthRefV1;
    runnerRef: OwnerTruthRefV1;
    evaluationEnvRef: OwnerTruthRefV1;
    captureRef: OwnerTruthRefV1;
    evaluationRef: OwnerTruthRefV1;
  };
  candidates: MicroduckControlShowCandidate[];
}

export type MicroduckShowEvidence = MicroduckTrainingShowEvidence | MicroduckControlShowEvidence;

type MicroduckShowPhase<Evidence extends MicroduckShowEvidence> =
  | (Evidence & { phase: 'approval_ready' })
  | (Evidence & { phase: 'applying'; approvalRef: OwnerTruthRefV1 })
  | (Evidence & {
      phase: 'verifying';
      approvalRef: OwnerTruthRefV1;
      deployedRevision: ExactAssetVersionRefV1;
      deployedArtifactSha256: string;
    })
  | (Evidence & {
      phase: 'kept';
      approvalRef: OwnerTruthRefV1;
      deployedRevision: ExactAssetVersionRefV1;
      deployedArtifactSha256: string;
      freshOutcomeRef: OwnerTruthRefV1;
    })
  | (Evidence & {
      phase: 'rolled_back';
      approvalRef: OwnerTruthRefV1;
      deployedRevision: ExactAssetVersionRefV1;
      deployedArtifactSha256: string;
      rollbackReceiptRef: OwnerTruthRefV1;
    } & (Evidence extends MicroduckControlShowEvidence
        ? { restoreOutcomeRef: OwnerTruthRefV1 }
        : { restoreOutcomeRef?: never }));

export type MicroduckShowState =
  | MicroduckShowPhase<MicroduckTrainingShowEvidence>
  | MicroduckShowPhase<MicroduckControlShowEvidence>;

export interface MicroduckShowManifestV1 {
  manifestVersion: 'f311-microduck-show-v1';
  interventionKind?: MicroduckShowInterventionKind;
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
  sceneMedia?: Array<MicroduckShowMediaDescriptor & { assetUrl: string }>;
  deployedRevision?: ExactAssetVersionRefV1;
  evaluatedArtifactHash?: string;
  deployedArtifactHash?: string;
  freshOutcomeRef?: OwnerTruthRefV1;
  rollbackReceiptRef?: OwnerTruthRefV1;
  restoreOutcomeRef?: OwnerTruthRefV1;
  blockers?: Array<{ code: MicroduckBlockCode; ownerRef?: OwnerTruthRefV1 }>;
  action?: {
    kind: 'f246-approval';
    method: 'POST';
    approvalUrl: string;
    body: { reasonCode: 'accepted_as_proposed' };
  };
  generatedAt: string;
}
