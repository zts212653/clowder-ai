import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ExactAssetVersionRefV1, OwnerTruthRefV1 } from '@cat-cafe/shared';
import {
  isMeasuredControlEvaluation,
  selectedControlSubjectPassesHoldout,
  selectedPublicControlSubject,
} from './microduck-control-candidate-selection.js';
import {
  MICRODUCK_CONTROL_CANDIDATE_ORDER,
  MICRODUCK_CONTROL_SUBJECT_ORDER,
  type MicroduckControlEvaluationReceipt,
  type MicroduckControlExperiment,
  microduckControlEvaluationReceiptSchema,
  microduckControlExperimentSchema,
} from './microduck-control-evaluation-schemas.js';
import type { MicroduckControlSlotVersionV1 } from './microduck-control-slot-state.js';
import {
  MICRODUCK_OWNER_FEATURE_ID,
  type MicroduckBlocked,
  type MicroduckVerification,
} from './microduck-owner-contract.js';

const EXPECTED_ROLES = ['deployed_reference', 'matched_control', 'candidate', 'candidate', 'candidate'] as const;
const EXPECTED_SCALES = [1, 1, 0.9, 1.05, 1.1] as const;
const EXPECTED_CONFIG_PATHS = [
  'control-configs/action-scale-100.json',
  'control-configs/action-scale-100.json',
  'control-configs/action-scale-090.json',
  'control-configs/action-scale-105.json',
  'control-configs/action-scale-110.json',
] as const;

type ReadBytes = (path: string) => Promise<Uint8Array>;

export interface MicroduckControlCandidateContractOptions {
  experimentPath: string;
  receiptPath: string;
  readBytes?: ReadBytes;
}

export interface ResolvedMicroduckControlCandidateContract extends Omit<MicroduckVerification, 'status'> {
  status: 'resolved';
  selectedSubjectId: (typeof MICRODUCK_CONTROL_CANDIDATE_ORDER)[number];
  experimentRef: OwnerTruthRefV1;
  baselineVersionRef: ExactAssetVersionRefV1;
  baselineControlVersion: MicroduckControlSlotVersionV1;
  candidateControlVersion: MicroduckControlSlotVersionV1;
  configRef: OwnerTruthRefV1;
  runnerRef: OwnerTruthRefV1;
  evaluationEnvRef: OwnerTruthRefV1;
  policyVersionRef: ExactAssetVersionRefV1;
  candidateConfigBytes: Uint8Array;
}

const blocked = (code: MicroduckBlocked['code']): MicroduckBlocked => ({ status: 'blocked', code });
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

const canonicalJson = (value: unknown): string => `${JSON.stringify(canonicalize(value), null, 2)}\n`;
const parseJson = (bytes: Uint8Array): unknown => JSON.parse(Buffer.from(bytes).toString('utf8'));
const ownerRef = (ownerStateRef: string, version?: string): OwnerTruthRefV1 => ({
  ownerFeatureId: MICRODUCK_OWNER_FEATURE_ID,
  ownerStateRef,
  ...(version ? { version } : {}),
});
const exactRef = (
  ownerStateRef: string,
  version: string,
  assetKind: string,
  assetId: string,
): ExactAssetVersionRefV1 => ({
  ownerFeatureId: MICRODUCK_OWNER_FEATURE_ID,
  ownerStateRef,
  version,
  assetKind,
  assetId,
});

function refHash(value: string, namespace: string): string | undefined {
  return new RegExp(`^${namespace}:sha256:([a-f0-9]{64})$`, 'u').exec(value)?.[1];
}

function packageBody(subject: MicroduckControlExperiment['subjects'][number]): Record<string, unknown> {
  return {
    artifactKind: 'microduck-control-package',
    configRef: subject.configRef,
    evaluationEnvRef: subject.evaluationEnvRef,
    policyRef: subject.policyRef,
    policySha256: subject.policySha256,
    runnerRef: subject.runnerRef,
    schemaVersion: 1,
  };
}

function exactExperiment(experiment: MicroduckControlExperiment): boolean {
  if (
    experiment.subjectOrder.some((id, index) => id !== MICRODUCK_CONTROL_SUBJECT_ORDER[index]) ||
    refHash(experiment.runnerRef, 'runner') !== experiment.runnerSha256 ||
    refHash(experiment.evaluationEnvRef, 'evaluation-env') !== experiment.evaluationEnvSha256 ||
    refHash(experiment.publicSeedSet.ref, 'seed-set') !== experiment.publicSeedSet.sha256
  ) {
    return false;
  }
  return experiment.subjects.every((subject, index) => {
    const artifactHash = refHash(subject.artifactRef, 'control-package');
    return (
      subject.id === MICRODUCK_CONTROL_SUBJECT_ORDER[index] &&
      subject.role === EXPECTED_ROLES[index] &&
      subject.actionScale === EXPECTED_SCALES[index] &&
      subject.configPath === EXPECTED_CONFIG_PATHS[index] &&
      subject.policyRef === experiment.policyRef &&
      subject.policySha256 === experiment.policySha256 &&
      subject.runnerRef === experiment.runnerRef &&
      subject.evaluationEnvRef === experiment.evaluationEnvRef &&
      refHash(subject.configRef, 'control-config') === subject.configSha256 &&
      artifactHash === subject.artifactVersion &&
      hash(canonicalJson(packageBody(subject))) === artifactHash
    );
  });
}

async function verifyExperimentFiles(
  experiment: MicroduckControlExperiment,
  experimentPath: string,
  readBytes: ReadBytes,
): Promise<Map<string, Uint8Array>> {
  const pipelineRoot = resolve(dirname(experimentPath), '..');
  const paths = [
    [experiment.runnerPath, experiment.runnerSha256],
    [experiment.evaluationEnvPath, experiment.evaluationEnvSha256],
    [experiment.publicSeedSet.path, experiment.publicSeedSet.sha256],
    ...experiment.subjects.map((subject) => [subject.configPath, subject.configSha256] as const),
  ] as const;
  const verified = new Map<string, Uint8Array>();
  for (const [relativePath, expectedSha256] of paths) {
    if (verified.has(relativePath)) continue;
    const bytes = await readBytes(resolve(pipelineRoot, relativePath));
    if (hash(bytes) !== expectedSha256) throw new Error(`bytes drifted: ${relativePath}`);
    verified.set(relativePath, bytes);
  }
  const publicSeeds = parseJson(verified.get(experiment.publicSeedSet.path) as Uint8Array) as {
    seeds?: unknown[];
  };
  if (!Array.isArray(publicSeeds.seeds) || publicSeeds.seeds.length !== experiment.publicSeedSet.count) {
    throw new Error('public seed count drifted');
  }
  for (const subject of experiment.subjects) {
    const config = parseJson(verified.get(subject.configPath) as Uint8Array) as Record<string, unknown>;
    if (
      Object.keys(config).sort().join(',') !== 'actionScale,schemaVersion' ||
      config.schemaVersion !== 1 ||
      config.actionScale !== subject.actionScale
    ) {
      throw new Error(`config is not single-variable: ${subject.id}`);
    }
  }
  return verified;
}

function receiptMatchesExperiment(
  receipt: MicroduckControlEvaluationReceipt,
  experiment: MicroduckControlExperiment,
): boolean {
  if (
    receipt.experimentRef !== `control-experiment:sha256:${hash(canonicalJson(experiment))}` ||
    receipt.runnerRef !== experiment.runnerRef ||
    receipt.evaluationEnvRef !== experiment.evaluationEnvRef ||
    canonicalJson(receipt.comparisonContract) !== canonicalJson(experiment.comparisonContract) ||
    receipt.seedSets.public.ref !== experiment.publicSeedSet.ref ||
    receipt.seedSets.public.sha256 !== experiment.publicSeedSet.sha256
  ) {
    return false;
  }
  return receipt.subjects.every((subject, index) => {
    const expected = experiment.subjects[index];
    return (
      subject.id === expected.id &&
      subject.role === expected.role &&
      subject.artifactRef === expected.artifactRef &&
      subject.artifactVersion === expected.artifactVersion &&
      subject.policyRef === expected.policyRef &&
      subject.policySha256 === expected.policySha256 &&
      subject.configRef === expected.configRef &&
      subject.configSha256 === expected.configSha256 &&
      subject.runnerRef === expected.runnerRef &&
      subject.evaluationEnvRef === expected.evaluationEnvRef &&
      subject.evaluations[0]?.split === 'public' &&
      subject.evaluations[1]?.split === 'holdout'
    );
  });
}

function policyRevision(policyRef: string): string | undefined {
  return /^hf-space:[^/]+\/[^@]+@([a-f0-9]{40})#\S+\.onnx$/u.exec(policyRef)?.[1];
}

function resolvedContract(
  receipt: MicroduckControlEvaluationReceipt,
  experiment: MicroduckControlExperiment,
  selectedSubjectId: (typeof MICRODUCK_CONTROL_CANDIDATE_ORDER)[number],
  verifiedFiles: Map<string, Uint8Array>,
): ResolvedMicroduckControlCandidateContract {
  const selected = experiment.subjects.find((subject) => subject.id === selectedSubjectId);
  const baseline = experiment.subjects[0];
  const revision = policyRevision(experiment.policyRef);
  if (!selected || !baseline || !revision || !receipt.holdoutProof) throw new Error('resolved tuple missing');
  const experimentRef = ownerRef(receipt.experimentRef, receipt.experimentRef.slice(-64));
  const evaluationReceiptRef = ownerRef(`evaluation:sha256:${receipt.receiptSha256}`, receipt.receiptSha256);
  const controlVersion = (subject: MicroduckControlExperiment['subjects'][number]): MicroduckControlSlotVersionV1 => {
    const artifactVersionRef = exactRef(subject.artifactRef, subject.artifactVersion, 'control-package', subject.id);
    const verificationSha256 = hash(
      canonicalJson({
        candidateVersionRef: artifactVersionRef,
        evaluationReceiptRef,
        experimentRef,
        holdoutProof: receipt.holdoutProof,
        schemaVersion: 1,
      }),
    );
    const configBytes = verifiedFiles.get(subject.configPath);
    if (!configBytes) throw new Error(`verified config missing: ${subject.id}`);
    return {
      artifactVersionRef,
      configRef: ownerRef(subject.configRef, subject.configSha256),
      configBytes,
      policyVersionRef: exactRef(experiment.policyRef, revision, 'onnx-policy', 'walking'),
      policySha256: subject.policySha256,
      runnerRef: ownerRef(subject.runnerRef, subject.runnerRef.slice(-64)),
      evaluationEnvRef: ownerRef(subject.evaluationEnvRef, subject.evaluationEnvRef.slice(-64)),
      evaluationReceiptRef,
      verificationReceiptRef: ownerRef(`verification:sha256:${verificationSha256}`, verificationSha256),
    };
  };
  const baselineControlVersion = controlVersion(baseline);
  const candidateControlVersion = controlVersion(selected);
  const candidateVersionRef = candidateControlVersion.artifactVersionRef;
  return {
    status: 'resolved',
    selectedSubjectId,
    experimentRef,
    baselineVersionRef: baselineControlVersion.artifactVersionRef,
    baselineControlVersion,
    candidateControlVersion,
    candidateVersionRef,
    configRef: candidateControlVersion.configRef,
    runnerRef: candidateControlVersion.runnerRef,
    evaluationEnvRef: candidateControlVersion.evaluationEnvRef,
    policyVersionRef: candidateControlVersion.policyVersionRef,
    candidateConfigBytes: candidateControlVersion.configBytes,
    evaluationReceiptRef,
    verificationReceiptRef: candidateControlVersion.verificationReceiptRef,
    evaluatedArtifactSha256: selected.artifactVersion,
    publicEvaluationComplete: true,
    holdoutEvaluationComplete: true,
    holdoutSealed: true,
    holdoutSealedProofRef: ownerRef(
      receipt.holdoutProof.sealedProofRef,
      receipt.holdoutProof.sealedProofRef.slice(-64),
    ),
    holdoutOptimizerExposed: false,
    optimizerExposureProofRef: ownerRef(
      receipt.holdoutProof.optimizerExposureProofRef,
      receipt.holdoutProof.optimizerExposureProofRef.slice(-64),
    ),
    singleVariable: true,
  };
}

function validatedReceiptContract(
  receiptBytes: Uint8Array,
  experiment: MicroduckControlExperiment,
  verifiedFiles: Map<string, Uint8Array>,
): ResolvedMicroduckControlCandidateContract | MicroduckBlocked {
  const receipt = microduckControlEvaluationReceiptSchema.parse(parseJson(receiptBytes));
  const { receiptSha256: _ignored, ...body } = receipt;
  if (hash(canonicalJson(body)) !== receipt.receiptSha256 || !receiptMatchesExperiment(receipt, experiment)) {
    return blocked('artifact_hash_mismatch');
  }
  if (receipt.completeness !== 'full_complete' || !receipt.seedSets.holdout || !receipt.holdoutProof) {
    return blocked('holdout_incomplete');
  }
  if (
    receipt.holdoutProof.optimizerExposed ||
    receipt.seedSets.holdout.ref === receipt.seedSets.public.ref ||
    receipt.seedSets.holdout.sha256 === receipt.seedSets.public.sha256
  ) {
    return blocked('holdout_leakage');
  }
  const hasIncompleteEvaluation = receipt.subjects.some((subject) =>
    subject.evaluations.some((evaluation) => !isMeasuredControlEvaluation(evaluation)),
  );
  if (hasIncompleteEvaluation) return blocked('holdout_incomplete');
  const selected = selectedPublicControlSubject(receipt);
  if (selected === undefined) return blocked('artifact_hash_mismatch');
  if (selected === null || !selectedControlSubjectPassesHoldout(receipt, selected)) return blocked('holdout_failed');
  const selectedManifest = experiment.subjects.find((subject) => subject.id === selected);
  if (!selectedManifest) return blocked('artifact_hash_mismatch');
  return verifiedFiles.has(selectedManifest.configPath)
    ? resolvedContract(receipt, experiment, selected, verifiedFiles)
    : blocked('artifact_hash_mismatch');
}

export async function readMicroduckControlCandidateContract(
  options: MicroduckControlCandidateContractOptions,
): Promise<ResolvedMicroduckControlCandidateContract | MicroduckBlocked> {
  const readBytes = options.readBytes ?? (async (path: string) => new Uint8Array(await readFile(path)));
  let experiment: MicroduckControlExperiment;
  let verifiedFiles: Map<string, Uint8Array>;
  try {
    experiment = microduckControlExperimentSchema.parse(parseJson(await readBytes(options.experimentPath)));
    if (!exactExperiment(experiment)) return blocked('artifact_hash_mismatch');
    verifiedFiles = await verifyExperimentFiles(experiment, options.experimentPath, readBytes);
  } catch {
    return blocked('artifact_hash_mismatch');
  }

  let receiptBytes: Uint8Array;
  try {
    receiptBytes = await readBytes(options.receiptPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? blocked('holdout_incomplete')
      : blocked('artifact_hash_mismatch');
  }

  try {
    return validatedReceiptContract(receiptBytes, experiment, verifiedFiles);
  } catch {
    return blocked('artifact_hash_mismatch');
  }
}
