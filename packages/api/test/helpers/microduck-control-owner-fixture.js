import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMicroduckControlOwnerPort } from '../../dist/infrastructure/capability-evolution/adapters/microduck-control-owner-port.js';
import { createMicroduckControlSlotOwner } from '../../dist/infrastructure/capability-evolution/adapters/microduck-control-slot-owner.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

const canonicalJson = (value) => `${JSON.stringify(canonicalize(value), null, 2)}\n`;
export const ownerRef = (ownerStateRef, version = ownerStateRef.slice(-64)) => ({
  ownerFeatureId: 'microduck-owner',
  ownerStateRef,
  version,
});
const policyRevision = '1'.repeat(40);
const policyRef = `hf-space:pollen-robotics/microduck-simulator@${policyRevision}#app/public/policies/BEST_alpha_walking.onnx`;
const policySha256 = '2'.repeat(64);
const runnerRef = ownerRef(`runner:sha256:${'3'.repeat(64)}`);
const evaluationEnvRef = ownerRef(`evaluation-env:sha256:${'4'.repeat(64)}`);
export const evaluationReceiptRef = ownerRef(`evaluation:sha256:${'5'.repeat(64)}`);
const sealedProofRef = ownerRef(`evaluation-proof:sha256:${'6'.repeat(64)}`);
const exposureProofRef = ownerRef(`exposure-proof:sha256:${'7'.repeat(64)}`);
export const programRef = {
  ownerFeatureId: 'F311',
  ownerStateRef: 'evolution-program:5073988075254b6eac9a0de0e3a27125',
};
export const cycleRef = {
  ownerFeatureId: 'F311',
  ownerStateRef: `evolution-cycle:${programRef.ownerStateRef}:3`,
};
export const objectRef = {
  ownerFeatureId: 'microduck-owner',
  ownerStateRef: 'simulator:walking',
  version: policyRevision,
};
export const scope = { programRef, cycleRef, objectRef };

function version(subjectId, actionScale, proof) {
  const configBytes = Buffer.from(`${JSON.stringify({ actionScale, schemaVersion: 1 }, null, 2)}\n`);
  const configSha256 = sha256(configBytes);
  const configRef = ownerRef(`control-config:sha256:${configSha256}`, configSha256);
  const artifactVersion = sha256(
    canonicalJson({
      artifactKind: 'microduck-control-package',
      configRef: configRef.ownerStateRef,
      evaluationEnvRef: evaluationEnvRef.ownerStateRef,
      policyRef,
      policySha256,
      runnerRef: runnerRef.ownerStateRef,
      schemaVersion: 1,
    }),
  );
  return {
    artifactVersionRef: {
      ownerFeatureId: 'microduck-owner',
      ownerStateRef: `control-package:sha256:${artifactVersion}`,
      version: artifactVersion,
      assetKind: 'control-package',
      assetId: subjectId,
    },
    configRef,
    configBytes,
    policyVersionRef: {
      ownerFeatureId: 'microduck-owner',
      ownerStateRef: policyRef,
      version: policyRevision,
      assetKind: 'onnx-policy',
      assetId: 'walking',
    },
    policySha256,
    runnerRef,
    evaluationEnvRef,
    evaluationReceiptRef,
    verificationReceiptRef: ownerRef(`verification:sha256:${proof.repeat(64)}`),
  };
}

function resolvedCandidate(baseline, candidate) {
  return {
    status: 'resolved',
    selectedSubjectId: 'action-scale-110',
    experimentRef: ownerRef(`control-experiment:sha256:${'8'.repeat(64)}`),
    baselineVersionRef: baseline.artifactVersionRef,
    baselineControlVersion: baseline,
    candidateControlVersion: candidate,
    configRef: candidate.configRef,
    runnerRef,
    evaluationEnvRef,
    policyVersionRef: candidate.policyVersionRef,
    candidateConfigBytes: candidate.configBytes,
    evaluationReceiptRef,
    verificationReceiptRef: candidate.verificationReceiptRef,
    candidateVersionRef: candidate.artifactVersionRef,
    evaluatedArtifactSha256: candidate.artifactVersionRef.version,
    publicEvaluationComplete: true,
    holdoutEvaluationComplete: true,
    holdoutSealed: true,
    holdoutSealedProofRef: sealedProofRef,
    holdoutOptimizerExposed: false,
    optimizerExposureProofRef: exposureProofRef,
    singleVariable: true,
  };
}

export async function controlOwnerFixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'f311-microduck-control-owner-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const baseline = version('baseline', 1, '9');
  const candidate = version('action-scale-110', 1.1, 'a');
  const contract = resolvedCandidate(baseline, candidate);
  const slotOwner = createMicroduckControlSlotOwner({
    dataDir,
    initialVersion: baseline,
    now: () => '2026-09-07T06:00:00.000Z',
  });
  const owner = createMicroduckControlOwnerPort({
    programRef,
    objectRef,
    baselineVersionRef: baseline.artifactVersionRef,
    slotOwner,
    resolveCandidate: async () => contract,
    ...overrides,
  });
  const statePath = join(dataDir, 'capability-evolution', 'microduck-owner-v1', 'control-slot.json');
  return { baseline, candidate, contract, dataDir, owner, slotOwner, statePath };
}

export function controlWritebackInput(current, candidate, verificationReceiptRef, clientMessageId = 'deploy-control') {
  return {
    ...scope,
    targetVersionRef: current.targetVersionRef,
    candidateVersionRef: candidate.artifactVersionRef,
    proposalRef: { ownerFeatureId: 'F266', ownerStateRef: 'eval-repair-proposal:microduck-control-v1' },
    interventionRef: objectRef,
    permissionRef: ownerRef('permission:simulator:walking:control-v1', 'b'.repeat(64)),
    verificationReceiptRef,
    approvalRef: { ownerFeatureId: 'F246', ownerStateRef: 'approval:microduck-control-v1:accepted' },
    clientMessageId,
  };
}
