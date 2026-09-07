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

export function makeHarness(overrides = {}) {
  const calls = { authorize: 0, launchMutation: 0, writeback: 0, rollback: 0, collectFreshOutcome: 0 };
  const owner = {
    async observe() {
      return {
        status: 'observed',
        targetVersionRef,
        baselineVersionRef: rollbackVersionRef,
        observationRefs: [{ ownerFeatureId: 'microduck-owner', ownerStateRef: `capture:sha256:${shaA}` }],
      };
    },
    async launchMutation() {
      calls.launchMutation += 1;
      return {
        status: 'accepted',
        mutationReceiptRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: 'hf-job:owner/job-1' },
        candidateVersionRef,
      };
    },
    async resolveVerification() {
      return {
        status: 'verified',
        evaluationReceiptRef,
        verificationReceiptRef,
        candidateVersionRef,
        evaluatedArtifactSha256: shaA,
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
        deployedVersionRef,
        rollbackVersionRef,
        deployedArtifactSha256: shaA,
        deployedAt: '2026-09-04T01:00:00.000Z',
      };
    },
    async collectFreshOutcome() {
      calls.collectFreshOutcome += 1;
      return {
        status: 'fresh',
        outcomeReceiptRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: `fresh-outcome:sha256:${shaA}` },
        freshnessProofRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: `freshness-proof:sha256:${shaB}` },
        deployedVersionRef,
        deployedArtifactSha256: shaA,
        measuredAt: '2026-09-04T01:05:00.000Z',
      };
    },
    async rollback() {
      calls.rollback += 1;
      return {
        status: 'rolled_back',
        rollbackReceiptRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: `rollback-receipt:sha256:${shaA}` },
        restoredVersionRef: rollbackVersionRef,
      };
    },
    async resolveShowState() {
      return showState();
    },
    ...overrides.owner,
  };
  const credentialBoundary = {
    async authorize() {
      calls.authorize += 1;
      return { status: 'authorized', permissionRef, targetVersionRef };
    },
    ...overrides.credentialBoundary,
  };
  const approvalResolver = {
    async resolve() {
      return {
        status: 'approved',
        approvalRef,
        proposalRef: showState().approvalProposalRef,
        programRef,
        cycleRef,
        interventionRef,
        targetVersionRef,
      };
    },
    ...overrides.approvalResolver,
  };
  const proposalResolver = {
    async resolve() {
      return {
        status: 'pending',
        proposalRef: showState({ phase: 'approval_ready' }).approvalProposalRef,
        programRef,
        cycleRef,
        interventionRef,
        targetVersionRef,
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
