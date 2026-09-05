import {
  MICRODUCK_OWNER_FEATURE_ID,
  type MicroduckApprovalResolver,
  type MicroduckBlocked,
  type MicroduckCredentialBoundary,
  type MicroduckFreshOutcome,
  type MicroduckFreshOutcomeInput,
  type MicroduckMutationInput,
  type MicroduckObservation,
  type MicroduckOwnerPort,
  type MicroduckPermission,
  type MicroduckProgramScope,
  type MicroduckProposalResolver,
  type MicroduckRollbackInput,
  type MicroduckRollbackReceipt,
  type MicroduckVerification,
  type MicroduckVerificationInput,
  type MicroduckWritebackInput,
  type MicroduckWritebackReceipt,
} from './microduck-owner-contract.js';
import {
  microduckApprovalSchema,
  microduckFreshOutcomeSchema,
  microduckMutationSchema,
  microduckObservationSchema,
  microduckPermissionSchema,
  microduckRollbackSchema,
  microduckVerificationSchema,
  microduckWritebackSchema,
} from './microduck-owner-schemas.js';
import {
  blocked,
  exactRef,
  isMicroduckHashRef,
  isMicroduckJobRef,
  isMicroduckPolicyRef,
  isMicroduckTargetRef,
  microduckScope,
  ownerBlock,
  ownerRef,
  parsedOwnerResponse,
  sameAddress,
  sameAssetSurface,
  sameRef,
  validSha256,
  verificationGate,
} from './microduck-owner-validation.js';
import { projectMicroduckShowManifest } from './microduck-show-manifest.js';
import { resolveMicroduckShowMedia } from './microduck-show-media.js';
import { PROGRAM_ADAPTER_CAPABILITIES, type ProgramAdapterDescriptorV1 } from './program-adapter-registry.js';

export { MICRODUCK_OWNER_FEATURE_ID } from './microduck-owner-contract.js';

const descriptor: ProgramAdapterDescriptorV1 = {
  schemaVersion: 1,
  adapterId: 'microduck-owner-v1',
  adapterOwnerRef: {
    ownerFeatureId: 'F202',
    ownerStateRef: 'adapter:microduck-owner-v1',
    version: '1',
  },
  targetOwnerFeatureId: MICRODUCK_OWNER_FEATURE_ID,
  targetStateRefPrefix: 'simulator:',
  capabilities: PROGRAM_ADAPTER_CAPABILITIES,
};

type ApprovedWriteback = { status: 'approved' };

export interface MicroduckOwnerAdapterOptions {
  owner: MicroduckOwnerPort;
  credentialBoundary: MicroduckCredentialBoundary;
  approvalResolver: MicroduckApprovalResolver;
  proposalResolver: MicroduckProposalResolver;
  now?: () => string;
}

export function createMicroduckOwnerAdapter(options: MicroduckOwnerAdapterOptions) {
  const now = options.now ?? (() => new Date().toISOString());

  const observe = async (input: MicroduckProgramScope): Promise<MicroduckObservation | MicroduckBlocked> => {
    if (!microduckScope(input)) return blocked('owner_route_unavailable');
    const result = parsedOwnerResponse(
      microduckObservationSchema,
      await options.owner.observe(input),
      'owner_route_unavailable',
    );
    if (result.status === 'blocked') return ownerBlock(result, 'owner_route_unavailable');
    if (
      !sameAddress(result.targetVersionRef, input.objectRef) ||
      result.targetVersionRef.version !== input.objectRef.version
    ) {
      return blocked('target_drift');
    }
    if (
      !isMicroduckTargetRef(result.targetVersionRef) ||
      !isMicroduckPolicyRef(result.baselineVersionRef) ||
      result.observationRefs.some((ref) => !isMicroduckHashRef(ref, 'capture'))
    ) {
      return blocked('owner_route_unavailable');
    }
    return {
      status: 'observed',
      targetVersionRef: exactRef(result.targetVersionRef),
      baselineVersionRef: exactRef(result.baselineVersionRef),
      observationRefs: result.observationRefs.map(ownerRef),
    };
  };

  const permission = async (
    input: Parameters<MicroduckCredentialBoundary['authorize']>[0],
  ): Promise<MicroduckPermission | MicroduckBlocked> => {
    if (!microduckScope(input)) return blocked('owner_route_unavailable');
    if (
      !sameAddress(input.targetVersionRef, input.objectRef) ||
      input.targetVersionRef.version !== input.objectRef.version ||
      !isMicroduckTargetRef(input.targetVersionRef)
    ) {
      return blocked('target_drift');
    }
    const result = parsedOwnerResponse(
      microduckPermissionSchema,
      await options.credentialBoundary.authorize(input),
      'permission_missing',
    );
    if (result.status === 'blocked')
      return blocked(result.code === 'target_drift' ? 'target_drift' : 'permission_missing');
    if (!sameRef(ownerRef(result.permissionRef), ownerRef(input.permissionRef))) return blocked('permission_missing');
    if (!sameRef(exactRef(result.targetVersionRef), exactRef(input.targetVersionRef))) return blocked('target_drift');
    return {
      status: 'authorized',
      permissionRef: ownerRef(result.permissionRef),
      targetVersionRef: exactRef(result.targetVersionRef),
    };
  };

  const mutate = async (input: MicroduckMutationInput) => {
    const observation = await observe(input);
    if (observation.status === 'blocked') return observation;
    if (!sameRef(observation.targetVersionRef, exactRef(input.targetVersionRef))) return blocked('target_drift');
    const authorization = await permission({ ...input, operation: 'mutate' });
    if (authorization.status === 'blocked') return authorization;
    const result = parsedOwnerResponse(
      microduckMutationSchema,
      await options.owner.launchMutation(input),
      'job_failed',
    );
    if (result.status === 'blocked') return ownerBlock(result, 'job_failed');
    if (!isMicroduckJobRef(result.mutationReceiptRef) || !isMicroduckPolicyRef(result.candidateVersionRef)) {
      return blocked('job_failed');
    }
    return {
      status: 'accepted' as const,
      mutationReceiptRef: ownerRef(result.mutationReceiptRef),
      candidateVersionRef: exactRef(result.candidateVersionRef),
    };
  };

  const verify = async (input: MicroduckVerificationInput) => {
    if (!microduckScope(input)) return blocked('owner_route_unavailable');
    if (!isMicroduckPolicyRef(input.candidateVersionRef)) return blocked('target_drift');
    const result = parsedOwnerResponse(
      microduckVerificationSchema,
      await options.owner.resolveVerification(input),
      'verification_missing',
    );
    if (result.status === 'blocked') return ownerBlock(result, 'verification_missing');
    return verificationGate(result, input.candidateVersionRef, input.artifactSha256);
  };

  const authorizeWriteback = async (input: MicroduckWritebackInput): Promise<ApprovedWriteback | MicroduckBlocked> => {
    if (input.approvalRef.ownerFeatureId !== 'F246') return blocked('approval_missing');
    const observation = await observe(input);
    if (observation.status === 'blocked') return observation;
    if (!sameRef(observation.targetVersionRef, exactRef(input.targetVersionRef))) return blocked('target_drift');
    const authorization = await permission({ ...input, operation: 'writeback' });
    if (authorization.status === 'blocked') return authorization;
    const approval = parsedOwnerResponse(
      microduckApprovalSchema,
      await options.approvalResolver.resolve({ proposalRef: input.proposalRef }),
      'approval_missing',
    );
    if (approval.status === 'blocked') return blocked('approval_missing');
    const exactApproval =
      approval.approvalRef.ownerFeatureId === 'F246' &&
      sameRef(approval.approvalRef, input.approvalRef) &&
      sameRef(approval.proposalRef, input.proposalRef) &&
      sameRef(approval.programRef, input.programRef) &&
      sameRef(approval.cycleRef, input.cycleRef) &&
      sameRef(approval.interventionRef, input.interventionRef) &&
      sameRef(approval.targetVersionRef, input.targetVersionRef) &&
      sameAddress(approval.targetVersionRef, input.objectRef) &&
      approval.targetVersionRef.version === input.objectRef.version;
    return exactApproval ? { status: 'approved' } : blocked('approval_missing');
  };

  const resolveWritebackVerification = async (
    input: MicroduckWritebackInput,
  ): Promise<MicroduckVerification | MicroduckBlocked> => {
    const result = parsedOwnerResponse(
      microduckVerificationSchema,
      await options.owner.resolveVerification(input),
      'verification_missing',
    );
    if (result.status === 'blocked') return ownerBlock(result, 'verification_missing');
    const verified = verificationGate(result, input.candidateVersionRef);
    if (verified.status === 'blocked') return verified;
    return sameRef(verified.verificationReceiptRef, input.verificationReceiptRef)
      ? verified
      : blocked('verification_missing');
  };

  const compensateMismatchedDeployment = async (
    input: MicroduckWritebackInput,
    deployed: MicroduckWritebackReceipt,
    code: 'artifact_hash_mismatch' | 'target_drift',
  ): Promise<MicroduckBlocked> => {
    const rollbackAuthorization = await permission({ ...input, operation: 'rollback' });
    if (rollbackAuthorization.status === 'blocked') {
      return blocked(code, { blockerRef: ownerRef(deployed.writebackReceiptRef) });
    }
    const recovery = parsedOwnerResponse(
      microduckRollbackSchema,
      await options.owner.rollback({
        ...input,
        deployedVersionRef: deployed.deployedVersionRef,
        rollbackVersionRef: deployed.rollbackVersionRef,
        writebackReceiptRef: deployed.writebackReceiptRef,
      }),
      'rollback_failed',
    );
    if (
      recovery.status === 'rolled_back' &&
      (!isMicroduckHashRef(recovery.rollbackReceiptRef, 'rollback-receipt') ||
        !isMicroduckPolicyRef(recovery.restoredVersionRef))
    ) {
      return blocked(code, { blockerRef: ownerRef(deployed.writebackReceiptRef) });
    }
    return recovery.status === 'rolled_back'
      ? blocked(code, { recoveryRef: ownerRef(recovery.rollbackReceiptRef) })
      : blocked(code, {
          blockerRef:
            recovery.blockerRef === undefined ? ownerRef(deployed.writebackReceiptRef) : ownerRef(recovery.blockerRef),
        });
  };

  const writeback = async (input: MicroduckWritebackInput) => {
    const approval = await authorizeWriteback(input);
    if (approval.status === 'blocked') return approval;
    const verified = await resolveWritebackVerification(input);
    if (verified.status === 'blocked') return verified;
    const result = parsedOwnerResponse(
      microduckWritebackSchema,
      await options.owner.writeback(input),
      'writeback_failed',
    );
    if (result.status === 'blocked') return ownerBlock(result, 'writeback_failed');
    const deployed = result as MicroduckWritebackReceipt;
    if (
      !isMicroduckHashRef(deployed.writebackReceiptRef, 'deploy') ||
      !isMicroduckTargetRef(deployed.deployedVersionRef) ||
      !isMicroduckPolicyRef(deployed.rollbackVersionRef)
    ) {
      return blocked('writeback_failed');
    }
    if (!sameAssetSurface(deployed.deployedVersionRef, input.targetVersionRef)) {
      return compensateMismatchedDeployment(input, deployed, 'target_drift');
    }
    if (
      !validSha256(deployed.deployedArtifactSha256) ||
      deployed.deployedArtifactSha256 !== verified.evaluatedArtifactSha256
    ) {
      return compensateMismatchedDeployment(input, deployed, 'artifact_hash_mismatch');
    }
    return {
      ...deployed,
      writebackReceiptRef: ownerRef(deployed.writebackReceiptRef),
      deployedVersionRef: exactRef(deployed.deployedVersionRef),
      rollbackVersionRef: exactRef(deployed.rollbackVersionRef),
    };
  };

  const freshOutcome = async (input: MicroduckFreshOutcomeInput): Promise<MicroduckFreshOutcome | MicroduckBlocked> => {
    if (!microduckScope(input)) return blocked('owner_route_unavailable');
    const result = parsedOwnerResponse(
      microduckFreshOutcomeSchema,
      await options.owner.collectFreshOutcome(input),
      'fresh_outcome_missing',
    );
    if (result.status === 'blocked') return ownerBlock(result, 'fresh_outcome_missing');
    if (
      !isMicroduckHashRef(result.outcomeReceiptRef, 'fresh-outcome') ||
      !isMicroduckHashRef(result.freshnessProofRef, 'freshness-proof') ||
      !isMicroduckTargetRef(result.deployedVersionRef)
    ) {
      return blocked('fresh_outcome_missing');
    }
    if (!sameRef(exactRef(result.deployedVersionRef), exactRef(input.deployedVersionRef)))
      return blocked('target_drift');
    if (!validSha256(result.deployedArtifactSha256) || result.deployedArtifactSha256 !== input.expectedArtifactSha256) {
      return blocked('artifact_hash_mismatch');
    }
    return {
      ...result,
      outcomeReceiptRef: ownerRef(result.outcomeReceiptRef),
      freshnessProofRef: ownerRef(result.freshnessProofRef),
      deployedVersionRef: exactRef(result.deployedVersionRef),
    };
  };

  const rollback = async (input: MicroduckRollbackInput): Promise<MicroduckRollbackReceipt | MicroduckBlocked> => {
    if (!microduckScope(input)) return blocked('owner_route_unavailable');
    const authorization = await permission({ ...input, operation: 'rollback' });
    if (authorization.status === 'blocked') return authorization;
    const result = parsedOwnerResponse(microduckRollbackSchema, await options.owner.rollback(input), 'rollback_failed');
    if (result.status === 'blocked') return ownerBlock(result, 'rollback_failed');
    if (
      !isMicroduckHashRef(result.rollbackReceiptRef, 'rollback-receipt') ||
      !isMicroduckPolicyRef(result.restoredVersionRef) ||
      !sameRef(result.restoredVersionRef, input.rollbackVersionRef)
    ) {
      return blocked('rollback_failed');
    }
    return {
      status: 'rolled_back',
      rollbackReceiptRef: ownerRef(result.rollbackReceiptRef),
      restoredVersionRef: exactRef(result.restoredVersionRef),
    };
  };

  const manifest = (input: MicroduckProgramScope & { programSequence: number }) =>
    projectMicroduckShowManifest(
      {
        owner: options.owner,
        approvalResolver: options.approvalResolver,
        proposalResolver: options.proposalResolver,
        now,
      },
      input,
    );

  const media = (input: MicroduckProgramScope & { programSequence: number; sceneIndex: number }) =>
    resolveMicroduckShowMedia(
      {
        owner: options.owner,
        approvalResolver: options.approvalResolver,
        proposalResolver: options.proposalResolver,
      },
      input,
    );

  return { descriptor, observe, permission, mutate, verify, writeback, freshOutcome, rollback, manifest, media };
}

export type MicroduckOwnerAdapter = ReturnType<typeof createMicroduckOwnerAdapter>;
