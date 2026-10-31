import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { readMicroduckControlCandidateContract } from '../dist/infrastructure/capability-evolution/adapters/microduck-control-owner-contract.js';

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
const bytes = (value) => Buffer.from(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
const ref = (prefix, hash) => `${prefix}:sha256:${hash}`;
const policyRevision = '1'.repeat(40);
const policySha256 = '2'.repeat(64);
const policyRef = `hf-space:pollen-robotics/microduck-simulator@${policyRevision}#app/public/policies/BEST_alpha_walking.onnx`;
const subjectSpecs = [
  ['baseline', 'deployed_reference', 1],
  ['control', 'matched_control', 1],
  ['action-scale-090', 'candidate', 0.9],
  ['action-scale-105', 'candidate', 1.05],
  ['action-scale-110', 'candidate', 1.1],
];

function metric(estimate, standardError = 0.01) {
  return { estimate, standardError };
}

function metrics(distance, survival = 1, velocityError = 0.1) {
  return {
    meanAbsVelocityErrorMps: metric(velocityError),
    meanForwardDistanceM: metric(distance),
    survivalRate: metric(survival, 0),
  };
}

function evaluation(split, values) {
  return {
    split,
    status: 'passed',
    sampleCount: 8,
    captureRef: ref('capture', sha256(`${split}:${JSON.stringify(values)}`)),
    metrics: values,
    refusal: null,
  };
}

function makeFixture() {
  const files = new Map();
  const runner = bytes('print("microduck runner")\n');
  const environment = bytes({ schemaVersion: 1, runtime: 'test' });
  const publicSeeds = bytes({ schemaVersion: 1, seeds: [1, 2, 3, 4, 5, 6, 7, 8] });
  const runnerSha256 = sha256(runner);
  const evaluationEnvSha256 = sha256(environment);
  const publicSeedSha256 = sha256(publicSeeds);
  const runnerRef = ref('runner', runnerSha256);
  const evaluationEnvRef = ref('evaluation-env', evaluationEnvSha256);
  const subjects = subjectSpecs.map(([id, role, actionScale]) => {
    const config = bytes({ actionScale, schemaVersion: 1 });
    const configSha256 = sha256(config);
    const configRef = ref('control-config', configSha256);
    const packageBody = {
      artifactKind: 'microduck-control-package',
      configRef,
      evaluationEnvRef,
      policyRef,
      policySha256,
      runnerRef,
      schemaVersion: 1,
    };
    const artifactVersion = sha256(canonicalJson(packageBody));
    const configPath = `control-configs/${id === 'baseline' || id === 'control' ? 'action-scale-100' : id}.json`;
    files.set(configPath, config);
    return {
      actionScale,
      artifactRef: ref('control-package', artifactVersion),
      artifactVersion,
      configPath,
      configRef,
      configSha256,
      evaluationEnvRef,
      id,
      policyRef,
      policySha256,
      role,
      runnerRef,
    };
  });
  const comparisonContract = {
    allCandidatesRunHoldout: true,
    candidateSelectionSource: 'public_only',
    guardrailMetric: {
      direction: 'higher_is_better',
      key: 'survivalRate',
      nonInferiorityMargin: 0,
      rule: 'candidate_control_delta_gte_negative_non_inferiority_margin',
    },
    holdoutRole: 'confirm_or_reject_preselected_candidate',
    matchedControlSubjectId: 'control',
    minSeedCount: 8,
    otherwise: 'no_measured_improvement',
    primaryMetric: {
      direction: 'higher_is_better',
      key: 'meanForwardDistanceM',
      rule: 'candidate_control_delta_gt_k_times_combined_standard_error',
    },
    reportingMetric: {
      direction: 'lower_is_better',
      key: 'meanAbsVelocityErrorMps',
    },
    requiredMetricKeys: ['meanAbsVelocityErrorMps', 'meanForwardDistanceM', 'survivalRate'],
    selectionRule: 'eligible_candidate_with_largest_primary_delta_then_subject_order',
    standardErrorEstimator: 'sample_standard_deviation_divided_by_sqrt_n',
    standardErrorMultiplier: 2,
  };
  const experiment = {
    comparisonContract,
    evaluationEnvPath: 'control-configs/evaluation-environment-v1.json',
    evaluationEnvRef,
    evaluationEnvSha256,
    experimentId: 'f311-microduck-fixed-model-action-scale-v1',
    interventionKind: 'control_config',
    outcomesObservedBeforePreregistration: false,
    policyRef,
    policySha256,
    preregisteredAt: '2026-09-07T03:25:21Z',
    publicSeedSet: {
      count: 8,
      path: 'control-configs/public-seeds-v1.json',
      ref: ref('seed-set', publicSeedSha256),
      sha256: publicSeedSha256,
    },
    runnerPath: 'bin/microduck_control_runner.py',
    runnerRef,
    runnerSha256,
    schemaVersion: 1,
    status: 'preregistered',
    subjectOrder: subjectSpecs.map(([id]) => id),
    subjects,
  };
  const publicMetrics = {
    baseline: metrics(1),
    control: metrics(1),
    'action-scale-090': metrics(1.05),
    'action-scale-105': metrics(1.1),
    'action-scale-110': metrics(1.3),
  };
  const holdoutMetrics = {
    baseline: metrics(1),
    control: metrics(1),
    'action-scale-090': metrics(1.05),
    'action-scale-105': metrics(1.1),
    'action-scale-110': metrics(1.25),
  };
  const receiptBody = {
    comparisonContract,
    completeness: 'full_complete',
    evaluationEnvRef,
    evaluatorRevision: '3'.repeat(40),
    experimentRef: ref('control-experiment', sha256(canonicalJson(experiment))),
    holdoutProof: {
      optimizerExposed: false,
      optimizerExposureProofRef: ref('exposure-proof', '4'.repeat(64)),
      sealedProofRef: ref('evaluation-proof', '5'.repeat(64)),
    },
    interventionKind: 'control_config',
    kind: 'microduck_control_evaluation',
    publicDecision: {
      candidates: [
        {
          eligible: true,
          guardrailDelta: 0,
          guardrailMinimumDelta: 0,
          guardrailPass: true,
          primaryDelta: 0.05,
          primarySignal: true,
          primaryThreshold: 2 * Math.hypot(0.01, 0.01),
          subjectId: 'action-scale-090',
        },
        {
          eligible: true,
          guardrailDelta: 0,
          guardrailMinimumDelta: 0,
          guardrailPass: true,
          primaryDelta: 0.1,
          primarySignal: true,
          primaryThreshold: 2 * Math.hypot(0.01, 0.01),
          subjectId: 'action-scale-105',
        },
        {
          eligible: true,
          guardrailDelta: 0,
          guardrailMinimumDelta: 0,
          guardrailPass: true,
          primaryDelta: 0.3,
          primarySignal: true,
          primaryThreshold: 2 * Math.hypot(0.01, 0.01),
          subjectId: 'action-scale-110',
        },
      ],
      outcome: 'candidate_preselected_for_holdout',
      rule: 'eligible_candidate_with_largest_primary_delta_then_subject_order',
      selectedSubjectId: 'action-scale-110',
    },
    runnerRef,
    schemaVersion: 1,
    seedSets: {
      holdout: { ref: ref('seed-set', '6'.repeat(64)), sha256: '6'.repeat(64) },
      public: { ref: ref('seed-set', publicSeedSha256), sha256: publicSeedSha256 },
    },
    subjects: subjects.map((subject) => ({
      id: subject.id,
      role: subject.role,
      interventionKind: 'control_config',
      artifactRef: subject.artifactRef,
      artifactVersion: subject.artifactVersion,
      policyRef: subject.policyRef,
      policySha256: subject.policySha256,
      configRef: subject.configRef,
      configSha256: subject.configSha256,
      runnerRef: subject.runnerRef,
      evaluationEnvRef: subject.evaluationEnvRef,
      evaluations: [evaluation('public', publicMetrics[subject.id]), evaluation('holdout', holdoutMetrics[subject.id])],
    })),
  };
  const receipt = { ...receiptBody, receiptSha256: sha256(canonicalJson(receiptBody)) };
  files.set('control-experiment.json', bytes(experiment));
  files.set('bin/microduck_control_runner.py', runner);
  files.set('control-configs/evaluation-environment-v1.json', environment);
  files.set('control-configs/public-seeds-v1.json', publicSeeds);
  files.set('control-full-evaluation.json', bytes(receipt));
  const readBytes = async (path) => {
    const match = [...files].find(([suffix]) => path.endsWith(suffix));
    if (!match) throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' });
    return match[1];
  };
  return { experiment, files, readBytes, receipt, subjects };
}

function options(fixture) {
  return {
    experimentPath: '/repo/pipeline/manifests/control-experiment.json',
    receiptPath: '/owner/receipts/control-full-evaluation.json',
    readBytes: fixture.readBytes,
  };
}

function rewriteReceipt(fixture, mutate) {
  const receipt = structuredClone(fixture.receipt);
  mutate(receipt);
  const { receiptSha256: _ignored, ...body } = receipt;
  receipt.receiptSha256 = sha256(canonicalJson(body));
  fixture.files.set('control-full-evaluation.json', bytes(receipt));
}

describe('F311 Microduck control owner contract', () => {
  it('derives one immutable deployment tuple only from an exact full receipt', async () => {
    const fixture = makeFixture();
    const result = await readMicroduckControlCandidateContract(options(fixture));

    assert.equal(result.status, 'resolved');
    assert.equal(result.selectedSubjectId, 'action-scale-110');
    assert.equal(result.candidateVersionRef.ownerStateRef, fixture.subjects[4].artifactRef);
    assert.equal(result.candidateVersionRef.version, fixture.subjects[4].artifactVersion);
    assert.equal(result.candidateVersionRef.assetKind, 'control-package');
    assert.equal(result.configRef.ownerStateRef, fixture.subjects[4].configRef);
    assert.equal(result.policyVersionRef.ownerStateRef, policyRef);
    assert.equal(result.evaluationReceiptRef.ownerStateRef, `evaluation:sha256:${fixture.receipt.receiptSha256}`);
    assert.match(result.verificationReceiptRef.ownerStateRef, /^verification:sha256:[a-f0-9]{64}$/u);
    assert.equal(result.baselineControlVersion.artifactVersionRef.assetId, 'baseline');
    assert.equal(result.candidateControlVersion.artifactVersionRef.assetId, 'action-scale-110');
    assert.deepEqual(
      Buffer.from(result.baselineControlVersion.configBytes),
      fixture.files.get('control-configs/action-scale-100.json'),
    );
    assert.deepEqual(
      Buffer.from(result.candidateControlVersion.configBytes),
      fixture.files.get('control-configs/action-scale-110.json'),
    );
  });

  it('refuses public-only and all-refused holdout receipts', async () => {
    const publicOnly = makeFixture();
    rewriteReceipt(publicOnly, (receipt) => {
      receipt.completeness = 'public_complete';
      receipt.holdoutProof = null;
      receipt.seedSets.holdout = null;
      for (const subject of receipt.subjects) {
        subject.evaluations[1] = {
          split: 'holdout',
          status: 'missing',
          sampleCount: null,
          captureRef: null,
          metrics: null,
          refusal: { code: 'missing_result', evidenceRef: null, detailHash: null },
        };
      }
    });
    assert.deepEqual(await readMicroduckControlCandidateContract(options(publicOnly)), {
      status: 'blocked',
      code: 'holdout_incomplete',
    });

    const refused = makeFixture();
    rewriteReceipt(refused, (receipt) => {
      for (const subject of receipt.subjects) {
        subject.evaluations[1] = {
          split: 'holdout',
          status: 'refused',
          sampleCount: null,
          captureRef: null,
          metrics: null,
          refusal: { code: 'runner_error', evidenceRef: null, detailHash: '7'.repeat(64) },
        };
      }
    });
    assert.deepEqual(await readMicroduckControlCandidateContract(options(refused)), {
      status: 'blocked',
      code: 'holdout_incomplete',
    });
  });

  it('refuses holdout leakage and a public winner that fails sealed confirmation', async () => {
    const leaked = makeFixture();
    rewriteReceipt(leaked, (receipt) => {
      receipt.holdoutProof.optimizerExposed = true;
    });
    assert.deepEqual(await readMicroduckControlCandidateContract(options(leaked)), {
      status: 'blocked',
      code: 'holdout_leakage',
    });

    const failed = makeFixture();
    rewriteReceipt(failed, (receipt) => {
      const selected = receipt.subjects.find((subject) => subject.id === 'action-scale-110');
      selected.evaluations[1].metrics.meanForwardDistanceM.estimate = 1;
    });
    assert.deepEqual(await readMicroduckControlCandidateContract(options(failed)), {
      status: 'blocked',
      code: 'holdout_failed',
    });
  });

  it('refuses config bytes or receipt tuples that drift from the evaluated package', async () => {
    const configDrift = makeFixture();
    configDrift.files.set('control-configs/action-scale-110.json', bytes({ actionScale: 9, schemaVersion: 1 }));
    assert.deepEqual(await readMicroduckControlCandidateContract(options(configDrift)), {
      status: 'blocked',
      code: 'artifact_hash_mismatch',
    });

    const tupleDrift = makeFixture();
    rewriteReceipt(tupleDrift, (receipt) => {
      receipt.subjects[4].configRef = ref('control-config', '8'.repeat(64));
      receipt.subjects[4].configSha256 = '8'.repeat(64);
    });
    assert.deepEqual(await readMicroduckControlCandidateContract(options(tupleDrift)), {
      status: 'blocked',
      code: 'artifact_hash_mismatch',
    });
  });
});
