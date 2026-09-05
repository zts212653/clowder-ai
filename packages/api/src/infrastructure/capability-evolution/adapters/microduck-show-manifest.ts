import type { OwnerTruthRefV1 } from '@cat-cafe/shared';
import { proposalIdFromRef } from '../../harness-eval/eval-repair-evolution-owner-projection.js';
import {
  MICRODUCK_SHOW_CANDIDATE_SUBJECTS,
  type MicroduckApprovalResolver,
  type MicroduckBlocked,
  type MicroduckOwnerPort,
  type MicroduckProgramScope,
  type MicroduckProposalResolver,
  type MicroduckShowManifestV1,
  type MicroduckShowMediaDescriptor,
  type MicroduckShowState,
} from './microduck-owner-contract.js';
import {
  microduckApprovalSchema,
  microduckProposalSchema,
  microduckShowStateSchema,
} from './microduck-owner-schemas.js';
import {
  blocked,
  exactRef,
  isMicroduckArtifactRef,
  isMicroduckHashRef,
  isMicroduckJobRef,
  isMicroduckPolicyRef,
  isMicroduckTargetRef,
  microduckScope,
  ownerRef,
  parsedOwnerResponse,
  sameAddress,
  sameAssetSurface,
  sameRef,
  validSha256,
} from './microduck-owner-validation.js';

interface ShowManifestProjectorOptions {
  owner: Pick<MicroduckOwnerPort, 'resolveShowState'>;
  approvalResolver: MicroduckApprovalResolver;
  proposalResolver: MicroduckProposalResolver;
  now: () => string;
}

function blockedManifest(
  input: MicroduckProgramScope & { programSequence: number },
  issue: MicroduckBlocked,
  now: () => string,
): MicroduckShowManifestV1 {
  return {
    manifestVersion: 'f311-microduck-show-v1',
    tier: 'B',
    phase: 'blocked',
    actionState: 'disabled',
    programRef: ownerRef(input.programRef),
    programSequence: input.programSequence,
    candidates: [],
    blockers: [
      {
        code: issue.code,
        ...(issue.blockerRef ? { ownerRef: ownerRef(issue.blockerRef) } : {}),
      },
    ],
    generatedAt: now(),
  };
}

export function exactOwnerEvidence(state: MicroduckShowState, input: MicroduckProgramScope): boolean {
  return (
    state.candidates.length === 3 &&
    validSha256(state.evaluatedArtifactSha256) &&
    sameAddress(state.targetRevision, input.objectRef) &&
    state.targetRevision.version === input.objectRef.version &&
    isMicroduckPolicyRef(state.baseline.policyRevision, 'space') &&
    isMicroduckHashRef(state.baseline.captureRef, 'capture') &&
    isMicroduckHashRef(state.baseline.evaluationRef, 'evaluation') &&
    isMicroduckHashRef(state.holdoutProof.sealedProofRef, 'evaluation-proof') &&
    isMicroduckHashRef(state.holdoutProof.optimizerExposureProofRef, 'exposure-proof') &&
    state.holdoutProof.optimizerExposed === false &&
    isMicroduckTargetRef(state.targetRevision) &&
    isMicroduckPolicyRef(state.rollbackRevision, 'space') &&
    sameRef(state.rollbackRevision, state.baseline.policyRevision) &&
    state.candidates.some((candidate) => sameRef(candidate.policyRevision, state.candidateRevision)) &&
    state.candidates.every(
      (candidate, index) =>
        candidate.subjectId === MICRODUCK_SHOW_CANDIDATE_SUBJECTS[index] &&
        isMicroduckPolicyRef(candidate.policyRevision, 'model') &&
        isMicroduckHashRef(candidate.evaluationRef, 'evaluation') &&
        sameRef(candidate.evaluationRef, state.baseline.evaluationRef) &&
        /^[a-f0-9]{64}$/u.test(candidate.recipeSha256) &&
        isMicroduckJobRef(candidate.jobRef) &&
        isMicroduckArtifactRef(candidate.checkpointRef, 'pt', 'model') &&
        isMicroduckArtifactRef(candidate.onnxArtifactRef, 'onnx', 'model') &&
        sameAddress(candidate.policyRevision, candidate.onnxArtifactRef),
    ) &&
    proposalIdFromRef(state.approvalProposalRef) !== undefined
  );
}

export function validMicroduckSceneMedia(state: MicroduckShowState): MicroduckShowMediaDescriptor[] {
  if (!state.sceneMedia || state.sceneMedia.length === 0) return [];
  const scenes = new Set<number>();
  for (const media of state.sceneMedia) {
    if (scenes.has(media.sceneIndex) || !isMicroduckHashRef(media.captureRef, 'capture')) return [];
    scenes.add(media.sceneIndex);
  }
  return state.sceneMedia.map((media) => ({ ...media, captureRef: ownerRef(media.captureRef) }));
}

export function microduckSceneMediaUrl(programRef: OwnerTruthRefV1, sceneIndex: number): string {
  return `/api/capability-evolution/programs/${encodeURIComponent(programRef.ownerStateRef)}/adapter-media/${sceneIndex}`;
}

function deployedEvidenceMatches(state: MicroduckShowState): boolean {
  if (state.phase === 'approval_ready' || state.phase === 'applying') return true;
  const deploymentMatches =
    validSha256(state.deployedArtifactSha256) &&
    state.evaluatedArtifactSha256 === state.deployedArtifactSha256 &&
    isMicroduckTargetRef(state.deployedRevision) &&
    sameAssetSurface(state.deployedRevision, state.targetRevision);
  if (!deploymentMatches) return false;
  if (state.phase === 'kept') return isMicroduckHashRef(state.freshOutcomeRef, 'fresh-outcome');
  if (state.phase === 'rolled_back') return isMicroduckHashRef(state.rollbackReceiptRef, 'rollback-receipt');
  return true;
}

async function canonicalApprovalMatches(
  state: Exclude<MicroduckShowState, { phase: 'approval_ready' }>,
  input: MicroduckProgramScope,
  resolver: MicroduckApprovalResolver,
): Promise<boolean> {
  const approval = parsedOwnerResponse(
    microduckApprovalSchema,
    await resolver.resolve({ proposalRef: state.approvalProposalRef }),
    'approval_missing',
  );
  return (
    approval.status === 'approved' &&
    approval.approvalRef.ownerFeatureId === 'F246' &&
    sameRef(approval.approvalRef, state.approvalRef) &&
    sameRef(approval.proposalRef, state.approvalProposalRef) &&
    sameRef(approval.programRef, input.programRef) &&
    sameRef(approval.cycleRef, input.cycleRef) &&
    sameRef(approval.interventionRef, state.interventionRef) &&
    sameRef(approval.targetVersionRef, state.targetRevision) &&
    sameAddress(approval.targetVersionRef, input.objectRef) &&
    approval.targetVersionRef.version === input.objectRef.version
  );
}

async function canonicalPendingProposalMatches(
  state: Extract<MicroduckShowState, { phase: 'approval_ready' }>,
  input: MicroduckProgramScope,
  resolver: MicroduckProposalResolver,
): Promise<boolean> {
  const proposal = parsedOwnerResponse(
    microduckProposalSchema,
    await resolver.resolve({ proposalRef: state.approvalProposalRef }),
    'approval_missing',
  );
  return (
    proposal.status === 'pending' &&
    sameRef(proposal.proposalRef, state.approvalProposalRef) &&
    sameRef(proposal.programRef, input.programRef) &&
    sameRef(proposal.cycleRef, input.cycleRef) &&
    sameRef(proposal.interventionRef, state.interventionRef) &&
    sameRef(proposal.targetVersionRef, state.targetRevision) &&
    sameAddress(proposal.targetVersionRef, input.objectRef) &&
    proposal.targetVersionRef.version === input.objectRef.version
  );
}

export async function canonicalMicroduckShowTruthMatches(
  state: MicroduckShowState,
  input: MicroduckProgramScope,
  resolvers: Pick<ShowManifestProjectorOptions, 'approvalResolver' | 'proposalResolver'>,
): Promise<boolean> {
  return (
    exactOwnerEvidence(state, input) &&
    deployedEvidenceMatches(state) &&
    (state.phase === 'approval_ready'
      ? await canonicalPendingProposalMatches(state, input, resolvers.proposalResolver)
      : await canonicalApprovalMatches(state, input, resolvers.approvalResolver))
  );
}

function completedPhaseFields(state: MicroduckShowState): Partial<MicroduckShowManifestV1> {
  if (state.phase === 'approval_ready') return {};
  const approved = { approvalRef: ownerRef(state.approvalRef) };
  if (state.phase === 'applying') return approved;
  const deployed = {
    ...approved,
    deployedRevision: exactRef(state.deployedRevision),
    deployedArtifactHash: state.deployedArtifactSha256,
  };
  if (state.phase === 'kept') return { ...deployed, freshOutcomeRef: ownerRef(state.freshOutcomeRef) };
  if (state.phase === 'rolled_back') {
    return { ...deployed, rollbackReceiptRef: ownerRef(state.rollbackReceiptRef) };
  }
  return deployed;
}

function projectResolvedManifest(
  state: MicroduckShowState,
  input: MicroduckProgramScope & { programSequence: number },
  now: () => string,
): MicroduckShowManifestV1 {
  const proposalId = proposalIdFromRef(state.approvalProposalRef);
  if (!proposalId) throw new Error('validated F266 proposal ref disappeared');
  const sceneMedia = validMicroduckSceneMedia(state);
  return {
    manifestVersion: 'f311-microduck-show-v1',
    tier: 'A',
    phase: state.phase,
    actionState: state.phase === 'approval_ready' ? 'enabled' : 'disabled',
    programRef: ownerRef(input.programRef),
    programSequence: input.programSequence,
    baseline: {
      policyRevision: exactRef(state.baseline.policyRevision),
      captureRef: ownerRef(state.baseline.captureRef),
      evaluationRef: ownerRef(state.baseline.evaluationRef),
    },
    holdoutProof: {
      sealedProofRef: ownerRef(state.holdoutProof.sealedProofRef),
      optimizerExposureProofRef: ownerRef(state.holdoutProof.optimizerExposureProofRef),
      optimizerExposed: false,
    },
    candidates: state.candidates.map((candidate) => ({
      subjectId: candidate.subjectId,
      policyRevision: exactRef(candidate.policyRevision),
      evaluationRef: ownerRef(candidate.evaluationRef),
      recipeSha256: candidate.recipeSha256,
      jobRef: ownerRef(candidate.jobRef),
      checkpointRef: ownerRef(candidate.checkpointRef),
      onnxArtifactRef: ownerRef(candidate.onnxArtifactRef),
    })),
    candidateRevision: exactRef(state.candidateRevision),
    targetRevision: exactRef(state.targetRevision),
    rollbackRevision: exactRef(state.rollbackRevision),
    approvalProposalRef: ownerRef(state.approvalProposalRef),
    interventionRef: ownerRef(state.interventionRef),
    rejection: { kind: state.rejection.kind, ownerRef: ownerRef(state.rejection.ownerRef) },
    evaluatedArtifactHash: state.evaluatedArtifactSha256,
    ...(state.phase === 'approval_ready'
      ? {
          action: {
            kind: 'f246-approval' as const,
            method: 'POST' as const,
            approvalUrl: `/api/eval-repair-proposals/${encodeURIComponent(proposalId)}/approve`,
            body: { reasonCode: 'accepted_as_proposed' as const },
          },
        }
      : {}),
    ...(sceneMedia.length === 0
      ? {}
      : {
          sceneMedia: sceneMedia.map((media) => ({
            ...media,
            assetUrl: microduckSceneMediaUrl(input.programRef, media.sceneIndex),
          })),
        }),
    ...completedPhaseFields(state),
    generatedAt: now(),
  };
}

export async function projectMicroduckShowManifest(
  options: ShowManifestProjectorOptions,
  input: MicroduckProgramScope & { programSequence: number },
): Promise<MicroduckShowManifestV1 | MicroduckBlocked> {
  if (!microduckScope(input)) return blocked('owner_route_unavailable');
  if (
    !Number.isInteger(input.programSequence) ||
    input.programSequence < 0 ||
    input.programRef.ownerFeatureId !== 'F311'
  ) {
    return blocked('show_truth_incomplete');
  }
  const state = parsedOwnerResponse(
    microduckShowStateSchema,
    await options.owner.resolveShowState(input),
    'show_truth_incomplete',
  );
  if (state.status === 'blocked') return blockedManifest(input, state, options.now);
  if (!(await canonicalMicroduckShowTruthMatches(state, input, options))) {
    return blockedManifest(input, blocked('show_truth_incomplete'), options.now);
  }
  return projectResolvedManifest(state, input, options.now);
}
