import { createMicroduckOwnerAdapter } from '../../dist/infrastructure/capability-evolution/adapters/microduck-owner-adapter.js';

export const shaA = 'a'.repeat(64);
export const shaB = 'b'.repeat(64);
const baselineRevision = '1'.repeat(40);
const candidateRevision = '2'.repeat(40);
const deployedRevision = '3'.repeat(40);
export const programRef = {
  ownerFeatureId: 'F311',
  ownerStateRef: 'evolution-program:00000000000000000000000000000001',
};
export const cycleRef = {
  ownerFeatureId: 'F311',
  ownerStateRef: 'evolution-cycle:evolution-program:00000000000000000000000000000001:1',
};
export const objectRef = {
  ownerFeatureId: 'microduck-owner',
  ownerStateRef: 'simulator:walking',
  version: baselineRevision,
};
export const targetVersionRef = {
  ...objectRef,
  assetKind: 'simulator-policy-slot',
  assetId: 'walking',
};
export const candidateVersionRef = {
  ownerFeatureId: 'microduck-owner',
  ownerStateRef: `hf-model:owner/microduck-push-range@${candidateRevision}#exported/policy.onnx`,
  version: candidateRevision,
  assetKind: 'onnx-policy',
  assetId: 'push-range',
};
export const rollbackVersionRef = {
  ownerFeatureId: 'microduck-owner',
  ownerStateRef: `hf-space:pollen-robotics/microduck-simulator@${baselineRevision}#app/public/policies/BEST_alpha_walking.onnx`,
  version: baselineRevision,
  assetKind: 'onnx-policy',
  assetId: 'walking',
};
export const deployedVersionRef = {
  ...targetVersionRef,
  version: deployedRevision,
};
export const controlTargetVersionRef = {
  ...objectRef,
  assetKind: 'simulator-control-slot',
  assetId: 'walking',
};
export const controlBaselineVersionRef = {
  ownerFeatureId: 'microduck-owner',
  ownerStateRef: `control-package:sha256:${'6'.repeat(64)}`,
  version: '6'.repeat(64),
  assetKind: 'control-package',
  assetId: 'baseline',
};
export const controlCandidateVersionRef = {
  ownerFeatureId: 'microduck-owner',
  ownerStateRef: `control-package:sha256:${'9'.repeat(64)}`,
  version: '9'.repeat(64),
  assetKind: 'control-package',
  assetId: 'action-scale-110',
};
export const controlDeployedVersionRef = {
  ...controlTargetVersionRef,
  version: controlCandidateVersionRef.version,
};
export const controlRestoreOutcomeRef = {
  ownerFeatureId: 'microduck-owner',
  ownerStateRef: `restore-outcome:sha256:${'e'.repeat(64)}`,
};
export const permissionRef = { ownerFeatureId: 'F202', ownerStateRef: 'permission:microduck-walking-v1', version: '1' };
export const approvalRef = {
  ownerFeatureId: 'F246',
  ownerStateRef: 'approval:F266:microduck-adopt-v1:accepted',
  version: '2026-09-04T01:00:00.000Z',
};
export const evaluationReceiptRef = {
  ownerFeatureId: 'microduck-owner',
  ownerStateRef: `evaluation:sha256:${shaA}`,
  version: '1',
};
export const verificationReceiptRef = {
  ownerFeatureId: 'microduck-owner',
  ownerStateRef: `verification:sha256:${shaA}`,
  version: '1',
};
export const interventionRef = {
  ownerFeatureId: 'microduck-owner',
  ownerStateRef: `config-diff:sha256:${'c'.repeat(64)}`,
};
export const controlInterventionRef = {
  ownerFeatureId: 'microduck-owner',
  ownerStateRef: `control-experiment:sha256:${'d'.repeat(64)}`,
};

export function exactBase() {
  return { programRef, cycleRef, objectRef };
}

export function showState(overrides = {}) {
  const phase = overrides.phase ?? 'kept';
  const candidateSubjects = ['push-range', 'spawn-tilt', 'upright-weight'];
  const aggregateEvaluationRef = {
    ownerFeatureId: 'microduck-owner',
    ownerStateRef: `evaluation:sha256:${'5'.repeat(64)}`,
  };
  const common = {
    status: 'resolved',
    phase,
    interventionKind: 'training',
    baseline: {
      policyRevision: rollbackVersionRef,
      captureRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: `capture:sha256:${'4'.repeat(64)}` },
      evaluationRef: aggregateEvaluationRef,
    },
    holdoutProof: {
      sealedProofRef: {
        ownerFeatureId: 'microduck-owner',
        ownerStateRef: `evaluation-proof:sha256:${shaA}`,
      },
      optimizerExposureProofRef: {
        ownerFeatureId: 'microduck-owner',
        ownerStateRef: `exposure-proof:sha256:${shaB}`,
      },
      optimizerExposed: false,
    },
    candidates: [0, 1, 2].map((index) => {
      const revision = String(index + 2).repeat(40);
      return {
        subjectId: candidateSubjects[index],
        policyRevision: {
          ...candidateVersionRef,
          ownerStateRef: `hf-model:owner/microduck-${candidateSubjects[index]}@${revision}#exported/policy.onnx`,
          version: revision,
          assetId: candidateSubjects[index],
        },
        evaluationRef: aggregateEvaluationRef,
        recipeSha256: String(index + 3).repeat(64),
        jobRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: `hf-job:owner/job-${index + 1}` },
        checkpointRef: {
          ownerFeatureId: 'microduck-owner',
          ownerStateRef: `hf-model:owner/microduck-${candidateSubjects[index]}@${revision}#model_1500.pt`,
        },
        onnxArtifactRef: {
          ownerFeatureId: 'microduck-owner',
          ownerStateRef: `hf-model:owner/microduck-${candidateSubjects[index]}@${revision}#exported/policy.onnx`,
        },
      };
    }),
    candidateRevision: candidateVersionRef,
    targetRevision: targetVersionRef,
    rollbackRevision: rollbackVersionRef,
    approvalProposalRef: {
      ownerFeatureId: 'F266',
      ownerStateRef: 'eval-repair-proposal:microduck-adopt-v1',
    },
    interventionRef,
    rejection: {
      kind: 'artifact_hash_mismatch',
      ownerRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: `evaluation:sha256:${shaB}` },
    },
    evaluatedArtifactSha256: shaA,
  };
  if (phase === 'approval_ready') return { ...common, ...overrides };
  if (phase === 'applying') return { ...common, approvalRef, ...overrides };
  const deployed = {
    ...common,
    approvalRef,
    deployedRevision: deployedVersionRef,
    deployedArtifactSha256: shaA,
  };
  if (phase === 'verifying') return { ...deployed, ...overrides };
  if (phase === 'rolled_back') {
    return {
      ...deployed,
      rollbackReceiptRef: {
        ownerFeatureId: 'microduck-owner',
        ownerStateRef: `rollback-receipt:sha256:${shaA}`,
      },
      ...overrides,
    };
  }
  return {
    ...deployed,
    phase: 'kept',
    freshOutcomeRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: `fresh-outcome:sha256:${shaA}` },
    ...overrides,
  };
}

export function controlShowState(overrides = {}) {
  const phase = overrides.phase ?? 'kept';
  const aggregateEvaluationRef = {
    ownerFeatureId: 'microduck-owner',
    ownerStateRef: `evaluation:sha256:${'5'.repeat(64)}`,
  };
  const runnerRef = {
    ownerFeatureId: 'microduck-owner',
    ownerStateRef: `runner:sha256:${'a'.repeat(64)}`,
  };
  const evaluationEnvRef = {
    ownerFeatureId: 'microduck-owner',
    ownerStateRef: `evaluation-env:sha256:${'b'.repeat(64)}`,
  };
  const packageHashes = ['7'.repeat(64), '8'.repeat(64), '9'.repeat(64)];
  const candidateSubjects = ['action-scale-090', 'action-scale-105', 'action-scale-110'];
  const common = {
    status: 'resolved',
    phase,
    interventionKind: 'control_config',
    baseline: {
      policyRevision: rollbackVersionRef,
      artifactRevision: controlBaselineVersionRef,
      configRef: {
        ownerFeatureId: 'microduck-owner',
        ownerStateRef: `control-config:sha256:${'c'.repeat(64)}`,
      },
      runnerRef,
      evaluationEnvRef,
      captureRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: `capture:sha256:${'4'.repeat(64)}` },
      evaluationRef: aggregateEvaluationRef,
    },
    holdoutProof: {
      sealedProofRef: {
        ownerFeatureId: 'microduck-owner',
        ownerStateRef: `evaluation-proof:sha256:${shaA}`,
      },
      optimizerExposureProofRef: {
        ownerFeatureId: 'microduck-owner',
        ownerStateRef: `exposure-proof:sha256:${shaB}`,
      },
      optimizerExposed: false,
    },
    candidates: candidateSubjects.map((subjectId, index) => ({
      subjectId,
      policyRevision: rollbackVersionRef,
      artifactRevision: {
        ownerFeatureId: 'microduck-owner',
        ownerStateRef: `control-package:sha256:${packageHashes[index]}`,
        version: packageHashes[index],
        assetKind: 'control-package',
        assetId: subjectId,
      },
      configRef: {
        ownerFeatureId: 'microduck-owner',
        ownerStateRef: `control-config:sha256:${String(index + 1).repeat(64)}`,
      },
      runnerRef,
      evaluationEnvRef,
      evaluationRef: aggregateEvaluationRef,
    })),
    candidateRevision: controlCandidateVersionRef,
    targetRevision: controlTargetVersionRef,
    rollbackRevision: controlBaselineVersionRef,
    approvalProposalRef: {
      ownerFeatureId: 'F266',
      ownerStateRef: 'eval-repair-proposal:microduck-control-adopt-v1',
    },
    interventionRef: controlInterventionRef,
    rejection: {
      kind: 'not_reproducible',
      ownerRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: `evaluation:sha256:${shaB}` },
    },
    evaluatedArtifactSha256: controlCandidateVersionRef.version,
  };
  if (phase === 'approval_ready') return { ...common, ...overrides };
  if (phase === 'applying') return { ...common, approvalRef, ...overrides };
  const deployed = {
    ...common,
    approvalRef,
    deployedRevision: controlDeployedVersionRef,
    deployedArtifactSha256: controlCandidateVersionRef.version,
  };
  if (phase === 'verifying') return { ...deployed, ...overrides };
  if (phase === 'rolled_back') {
    return {
      ...deployed,
      rollbackReceiptRef: {
        ownerFeatureId: 'microduck-owner',
        ownerStateRef: `rollback-receipt:sha256:${shaA}`,
      },
      restoreOutcomeRef: controlRestoreOutcomeRef,
      ...overrides,
    };
  }
  return {
    ...deployed,
    phase: 'kept',
    freshOutcomeRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: `fresh-outcome:sha256:${shaA}` },
    ...overrides,
  };
}

export function makeHarness(overrides = {}) {
  const calls = { authorize: 0, launchMutation: 0, writeback: 0, rollback: 0, collectFreshOutcome: 0 };
  const profile = overrides.profile ?? {
    targetVersionRef,
    candidateVersionRef,
    rollbackVersionRef,
    deployedVersionRef,
    interventionRef,
    showState,
    artifactSha256: shaA,
  };
  const owner = {
    async observe() {
      return {
        status: 'observed',
        targetVersionRef: profile.targetVersionRef,
        baselineVersionRef: profile.rollbackVersionRef,
        observationRefs: [{ ownerFeatureId: 'microduck-owner', ownerStateRef: `capture:sha256:${shaA}` }],
      };
    },
    async launchMutation() {
      calls.launchMutation += 1;
      return {
        status: 'accepted',
        mutationReceiptRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: 'hf-job:owner/job-1' },
        candidateVersionRef: profile.candidateVersionRef,
      };
    },
    async resolveVerification() {
      return {
        status: 'verified',
        evaluationReceiptRef,
        verificationReceiptRef,
        candidateVersionRef: profile.candidateVersionRef,
        evaluatedArtifactSha256: profile.artifactSha256,
        publicEvaluationComplete: true,
        holdoutEvaluationComplete: true,
        holdoutSealed: true,
        holdoutSealedProofRef: {
          ownerFeatureId: 'microduck-owner',
          ownerStateRef: `evaluation-proof:sha256:${shaA}`,
        },
        holdoutOptimizerExposed: false,
        optimizerExposureProofRef: {
          ownerFeatureId: 'microduck-owner',
          ownerStateRef: `exposure-proof:sha256:${shaB}`,
        },
        singleVariable: true,
      };
    },
    async writeback() {
      calls.writeback += 1;
      return {
        status: 'deployed',
        writebackReceiptRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: `deploy:sha256:${shaA}` },
        deployedVersionRef: profile.deployedVersionRef,
        rollbackVersionRef: profile.rollbackVersionRef,
        deployedArtifactSha256: profile.artifactSha256,
        deployedAt: '2026-09-04T01:00:00.000Z',
      };
    },
    async collectFreshOutcome() {
      calls.collectFreshOutcome += 1;
      return {
        status: 'fresh',
        outcomeReceiptRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: `fresh-outcome:sha256:${shaA}` },
        freshnessProofRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: `freshness-proof:sha256:${shaB}` },
        deployedVersionRef: profile.deployedVersionRef,
        deployedArtifactSha256: profile.artifactSha256,
        measuredAt: '2026-09-04T01:05:00.000Z',
      };
    },
    async rollback() {
      calls.rollback += 1;
      return {
        status: 'rolled_back',
        rollbackReceiptRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: `rollback-receipt:sha256:${shaA}` },
        restoredVersionRef: profile.rollbackVersionRef,
        ...(profile.restoreOutcomeRef ? { restoreOutcomeRef: profile.restoreOutcomeRef } : {}),
      };
    },
    async resolveShowState() {
      return profile.showState();
    },
    ...overrides.owner,
  };
  const credentialBoundary = {
    async authorize(input) {
      calls.authorize += 1;
      return { status: 'authorized', permissionRef, targetVersionRef: input.targetVersionRef };
    },
    ...overrides.credentialBoundary,
  };
  const approvalResolver = {
    async resolve() {
      return {
        status: 'approved',
        approvalRef,
        proposalRef: profile.showState().approvalProposalRef,
        programRef,
        cycleRef,
        interventionRef: profile.interventionRef,
        targetVersionRef: profile.targetVersionRef,
      };
    },
    ...overrides.approvalResolver,
  };
  const proposalResolver = {
    async resolve() {
      return {
        status: 'pending',
        proposalRef: profile.showState({ phase: 'approval_ready' }).approvalProposalRef,
        programRef,
        cycleRef,
        interventionRef: profile.interventionRef,
        targetVersionRef: profile.targetVersionRef,
      };
    },
    ...overrides.proposalResolver,
  };
  return {
    adapter: createMicroduckOwnerAdapter({
      owner,
      credentialBoundary,
      approvalResolver,
      proposalResolver,
      now: () => '2026-09-04T01:10:00.000Z',
    }),
    calls,
  };
}

export function makeControlHarness(overrides = {}) {
  return makeHarness({
    ...overrides,
    profile: {
      targetVersionRef: controlTargetVersionRef,
      candidateVersionRef: controlCandidateVersionRef,
      rollbackVersionRef: controlBaselineVersionRef,
      deployedVersionRef: controlDeployedVersionRef,
      interventionRef: controlInterventionRef,
      showState: controlShowState,
      artifactSha256: controlCandidateVersionRef.version,
      restoreOutcomeRef: controlRestoreOutcomeRef,
    },
  });
}
