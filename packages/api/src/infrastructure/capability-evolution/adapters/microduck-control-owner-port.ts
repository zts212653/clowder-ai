import type { ExactAssetVersionRefV1, OwnerTruthRefV1 } from '@cat-cafe/shared';
import {
  collectMicroduckLoadedOutcome,
  type MicroduckControlLoadedOutcomeRunner,
  microduckRestoreBlocked,
} from './microduck-control-loaded-outcome.js';
import type { ResolvedMicroduckControlCandidateContract } from './microduck-control-owner-contract.js';
import type { MicroduckControlSlotOwner, MicroduckControlSlotVersionV1 } from './microduck-control-slot-owner.js';
import { exactSame, normalizeVersion } from './microduck-control-slot-state.js';
import type {
  MicroduckBlocked,
  MicroduckOwnerPort,
  MicroduckProgramScope,
  MicroduckVerification,
} from './microduck-owner-contract.js';
import { microduckFreshOutcomeSchema, microduckRestoreOutcomeSchema } from './microduck-owner-schemas.js';
import {
  blocked,
  exactRef,
  isMicroduckControlPackageRef,
  isMicroduckHashRef,
  isMicroduckTargetRef,
  microduckScope,
  ownerBlock,
  ownerRef,
  parsedOwnerResponse,
  sameRef,
  verificationGate,
} from './microduck-owner-validation.js';

type VerificationInput = Parameters<MicroduckOwnerPort['resolveVerification']>[0];

export type {
  MicroduckControlLoadedOutcomeInput,
  MicroduckControlLoadedOutcomeRunner,
  MicroduckRestoreAttemptDiagnosis,
} from './microduck-control-loaded-outcome.js';
export { diagnoseMicroduckRestoreAttempt } from './microduck-control-loaded-outcome.js';

export interface MicroduckControlOwnerPortOptions {
  readonly programRef: OwnerTruthRefV1;
  readonly objectRef: OwnerTruthRefV1;
  readonly baselineVersionRef: ExactAssetVersionRefV1;
  readonly slotOwner: MicroduckControlSlotOwner;
  readonly resolveCandidate: (
    input: VerificationInput,
  ) => Promise<ResolvedMicroduckControlCandidateContract | MicroduckBlocked>;
  readonly loadedOutcomeRunner?: MicroduckControlLoadedOutcomeRunner;
}

type ResolvedCandidate = ResolvedMicroduckControlCandidateContract & {
  readonly baselineControlVersion: MicroduckControlSlotVersionV1;
  readonly candidateControlVersion: MicroduckControlSlotVersionV1;
};

interface NormalizedCandidateVersions {
  readonly baselineControlVersion: MicroduckControlSlotVersionV1;
  readonly candidateControlVersion: MicroduckControlSlotVersionV1;
}

const exactBytes = (left: Uint8Array, right: Uint8Array): boolean => Buffer.from(left).equals(Buffer.from(right));

function normalizedRefMatches(left: OwnerTruthRefV1, right: OwnerTruthRefV1): boolean {
  try {
    return sameRef(ownerRef(left), ownerRef(right));
  } catch {
    return false;
  }
}

function validConfiguredScope(programRef: OwnerTruthRefV1, objectRef: OwnerTruthRefV1): boolean {
  return (
    programRef.ownerFeatureId === 'F311' &&
    /^evolution-program:[a-f0-9]{32}$/u.test(programRef.ownerStateRef) &&
    programRef.version === undefined &&
    objectRef.ownerStateRef === 'simulator:walking' &&
    microduckScope({ programRef, cycleRef: programRef, objectRef })
  );
}

function normalizeCandidateVersions(
  candidate: ResolvedMicroduckControlCandidateContract,
): NormalizedCandidateVersions | undefined {
  try {
    return {
      baselineControlVersion: normalizeVersion(candidate.baselineControlVersion),
      candidateControlVersion: normalizeVersion(candidate.candidateControlVersion),
    };
  } catch {
    return undefined;
  }
}

function exactCandidateTuple(
  candidate: ResolvedMicroduckControlCandidateContract,
  versions: NormalizedCandidateVersions,
  expectedBaselineVersionRef: ExactAssetVersionRefV1,
  expectedCandidateVersionRef: ExactAssetVersionRefV1,
): boolean {
  const { baselineControlVersion, candidateControlVersion } = versions;
  return (
    exactSame(candidate.baselineVersionRef, expectedBaselineVersionRef) &&
    exactSame(baselineControlVersion.artifactVersionRef, expectedBaselineVersionRef) &&
    exactSame(candidate.candidateVersionRef, expectedCandidateVersionRef) &&
    exactSame(candidateControlVersion.artifactVersionRef, expectedCandidateVersionRef) &&
    exactSame(candidate.policyVersionRef, candidateControlVersion.policyVersionRef) &&
    normalizedRefMatches(candidate.configRef, candidateControlVersion.configRef) &&
    normalizedRefMatches(candidate.runnerRef, candidateControlVersion.runnerRef) &&
    normalizedRefMatches(candidate.evaluationEnvRef, candidateControlVersion.evaluationEnvRef) &&
    normalizedRefMatches(candidate.evaluationReceiptRef, candidateControlVersion.evaluationReceiptRef) &&
    normalizedRefMatches(candidate.verificationReceiptRef, candidateControlVersion.verificationReceiptRef) &&
    normalizedRefMatches(baselineControlVersion.evaluationReceiptRef, candidate.evaluationReceiptRef) &&
    exactSame(baselineControlVersion.policyVersionRef, candidateControlVersion.policyVersionRef) &&
    normalizedRefMatches(baselineControlVersion.runnerRef, candidateControlVersion.runnerRef) &&
    normalizedRefMatches(baselineControlVersion.evaluationEnvRef, candidateControlVersion.evaluationEnvRef) &&
    exactBytes(candidate.candidateConfigBytes, candidateControlVersion.configBytes) &&
    isMicroduckHashRef(candidate.experimentRef, 'control-experiment')
  );
}

function requestedReceiptsMatch(
  input: VerificationInput,
  candidate: ResolvedMicroduckControlCandidateContract,
): boolean {
  return (
    (!input.evaluationReceiptRef || normalizedRefMatches(input.evaluationReceiptRef, candidate.evaluationReceiptRef)) &&
    (!input.verificationReceiptRef ||
      normalizedRefMatches(input.verificationReceiptRef, candidate.verificationReceiptRef))
  );
}

export function createMicroduckControlOwnerPort(options: MicroduckControlOwnerPortOptions): MicroduckOwnerPort {
  const programRef = ownerRef(options.programRef);
  const objectRef = ownerRef(options.objectRef);
  const baselineVersionRef = exactRef(options.baselineVersionRef);
  if (!validConfiguredScope(programRef, objectRef) || !isMicroduckControlPackageRef(baselineVersionRef, 'baseline')) {
    throw new Error('Invalid Microduck control owner scope');
  }

  const exactScope = (input: MicroduckProgramScope): boolean => {
    const cyclePrefix = `evolution-cycle:${programRef.ownerStateRef}:`;
    return (
      normalizedRefMatches(input.programRef, programRef) &&
      normalizedRefMatches(input.objectRef, objectRef) &&
      input.cycleRef.ownerFeatureId === 'F311' &&
      input.cycleRef.version === undefined &&
      input.cycleRef.ownerStateRef.startsWith(cyclePrefix) &&
      /^[1-9]\d*$/u.test(input.cycleRef.ownerStateRef.slice(cyclePrefix.length))
    );
  };

  const verificationFrom = (candidate: ResolvedCandidate): MicroduckVerification => ({
    status: 'verified',
    evaluationReceiptRef: candidate.evaluationReceiptRef,
    verificationReceiptRef: candidate.verificationReceiptRef,
    candidateVersionRef: candidate.candidateVersionRef,
    evaluatedArtifactSha256: candidate.evaluatedArtifactSha256,
    publicEvaluationComplete: candidate.publicEvaluationComplete,
    holdoutEvaluationComplete: candidate.holdoutEvaluationComplete,
    holdoutSealed: candidate.holdoutSealed,
    holdoutSealedProofRef: candidate.holdoutSealedProofRef,
    holdoutOptimizerExposed: candidate.holdoutOptimizerExposed,
    optimizerExposureProofRef: candidate.optimizerExposureProofRef,
    singleVariable: candidate.singleVariable,
  });

  const resolveCandidate = async (input: VerificationInput): Promise<ResolvedCandidate | MicroduckBlocked> => {
    if (!exactScope(input) || !isMicroduckControlPackageRef(input.candidateVersionRef)) {
      return blocked('owner_route_unavailable');
    }
    let candidate: ResolvedMicroduckControlCandidateContract | MicroduckBlocked;
    try {
      candidate = await options.resolveCandidate(input);
    } catch {
      return blocked('artifact_hash_mismatch');
    }
    if (candidate.status === 'blocked') return ownerBlock(candidate, 'verification_missing');

    const versions = normalizeCandidateVersions(candidate);
    if (!versions || !exactCandidateTuple(candidate, versions, baselineVersionRef, input.candidateVersionRef)) {
      return blocked('artifact_hash_mismatch');
    }
    if (!requestedReceiptsMatch(input, candidate)) return blocked('verification_missing');
    const verified = verificationGate(verificationFrom(candidate), input.candidateVersionRef);
    return verified.status === 'blocked' ? verified : { ...candidate, ...versions };
  };

  const owner: MicroduckOwnerPort = {
    async observe(input) {
      if (!exactScope(input)) return blocked('owner_route_unavailable');
      const current = await options.slotOwner.readCurrent();
      if (current.status === 'blocked') return current;
      return {
        status: 'observed',
        targetVersionRef: current.targetVersionRef,
        baselineVersionRef,
        baselineArtifactSha256: baselineVersionRef.version,
        observationRefs: [],
      };
    },

    async launchMutation(input) {
      return exactScope(input) ? blocked('job_failed') : blocked('owner_route_unavailable');
    },

    async resolveVerification(input) {
      const candidate = await resolveCandidate(input);
      return candidate.status === 'blocked' ? candidate : verificationFrom(candidate);
    },

    async writeback(input) {
      const candidate = await resolveCandidate(input);
      if (candidate.status === 'blocked') return candidate;
      if (!normalizedRefMatches(input.verificationReceiptRef, candidate.verificationReceiptRef)) {
        return blocked('verification_missing');
      }
      return options.slotOwner.writeback({
        expectedTargetVersionRef: input.targetVersionRef,
        candidateVersion: candidate.candidateControlVersion,
        clientMessageId: input.clientMessageId,
      });
    },

    async collectFreshOutcome(input) {
      if (
        !exactScope(input) ||
        !isMicroduckTargetRef(input.deployedVersionRef) ||
        !isMicroduckHashRef(input.writebackReceiptRef, 'deploy')
      ) {
        return blocked('fresh_outcome_missing');
      }
      const deployment = await options.slotOwner.readDeployment(input);
      if (!deployment || !options.loadedOutcomeRunner) return blocked('fresh_outcome_missing');
      const result = parsedOwnerResponse(
        microduckFreshOutcomeSchema,
        await collectMicroduckLoadedOutcome(
          options.loadedOutcomeRunner,
          {
            mode: 'post_writeback',
            operationReceiptRef: deployment.writebackReceiptRef,
            targetVersionRef: deployment.targetVersionRef,
            version: deployment.version,
          },
          'fresh_outcome_missing',
        ),
        'fresh_outcome_missing',
      );
      if (result.status === 'blocked') return ownerBlock(result, 'fresh_outcome_missing');
      if (
        !exactSame(result.deployedVersionRef, input.deployedVersionRef) ||
        !isMicroduckHashRef(result.outcomeReceiptRef, 'fresh-outcome') ||
        !isMicroduckHashRef(result.freshnessProofRef, 'freshness-proof') ||
        result.deployedArtifactSha256 !== deployment.version.artifactVersionRef.version
      ) {
        return blocked('fresh_outcome_missing');
      }
      return result;
    },

    async rollback(input) {
      if (
        !exactScope(input) ||
        !input.deployedVersionRef ||
        !input.writebackReceiptRef ||
        !isMicroduckHashRef(input.writebackReceiptRef, 'deploy')
      ) {
        return blocked('rollback_failed');
      }
      if (!exactSame(input.targetVersionRef, input.deployedVersionRef)) {
        return blocked('rollback_failed');
      }
      const rollbackReceipt = await options.slotOwner.rollback({
        expectedTargetVersionRef: input.targetVersionRef,
        rollbackVersionRef: input.rollbackVersionRef,
        writebackReceiptRef: input.writebackReceiptRef,
        clientMessageId: input.clientMessageId,
      });
      if (rollbackReceipt.status === 'blocked') return blocked('rollback_failed');

      const restored = await options.slotOwner.readCurrent();
      if (
        restored.status === 'blocked' ||
        !exactSame(restored.version.artifactVersionRef, rollbackReceipt.restoredVersionRef) ||
        !options.loadedOutcomeRunner ||
        !input.referenceFreshOutcomeRef ||
        !isMicroduckHashRef(input.referenceFreshOutcomeRef, 'fresh-outcome')
      ) {
        return microduckRestoreBlocked(blocked('rollback_failed'), rollbackReceipt);
      }
      const result = parsedOwnerResponse(
        microduckRestoreOutcomeSchema,
        await collectMicroduckLoadedOutcome(
          options.loadedOutcomeRunner,
          {
            mode: 'post_rollback',
            operationReceiptRef: rollbackReceipt.rollbackReceiptRef,
            deploymentReceiptRef: ownerRef(input.writebackReceiptRef),
            targetVersionRef: restored.targetVersionRef,
            referenceFreshOutcomeRef: ownerRef(input.referenceFreshOutcomeRef),
            version: restored.version,
          },
          'rollback_failed',
        ),
        'rollback_failed',
      );
      if (result.status === 'blocked') return microduckRestoreBlocked(result, rollbackReceipt);
      if (
        !isMicroduckHashRef(result.outcomeReceiptRef, 'restore-outcome') ||
        !isMicroduckHashRef(result.freshnessProofRef, 'freshness-proof') ||
        !exactSame(result.restoredVersionRef, rollbackReceipt.restoredVersionRef) ||
        result.restoredArtifactSha256 !== restored.version.artifactVersionRef.version
      ) {
        return microduckRestoreBlocked(blocked('rollback_failed'), rollbackReceipt);
      }
      return {
        ...rollbackReceipt,
        restoreOutcomeRef: ownerRef(result.outcomeReceiptRef),
      };
    },

    async resolveShowState(input) {
      return exactScope(input) ? blocked('show_truth_incomplete') : blocked('owner_route_unavailable');
    },
  };
  return owner;
}
