import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateAdaptiveSopComparativePilot,
  fingerprintAdaptiveSopComparativePilotManifest,
  fingerprintAdaptiveSopComparativePolicy,
  fingerprintAdaptiveSopComparativeResolvedEvidence,
  fingerprintAdaptiveSopComparativeTrialEvidence,
} from '../../dist/infrastructure/harness-eval/sop/adaptive-sop-comparative-pilot.js';

const ARMS = ['full_sop', 'free_plan_hard_gates', 'adaptive_plan_hard_gates'];

function buildTrial(arm, trialIndex, overrides = {}) {
  const adaptive = arm === 'adaptive_plan_hard_gates';
  return signTrial({
    arm,
    trialIndex,
    model: { provider: 'openai', modelId: 'gpt-5.6-sol' },
    harnessVersion: adaptive ? 'lf-0001.adaptive-v1' : `lf-0001.${arm}-v1`,
    provenance: {
      baseSha: 'a'.repeat(40),
      finalSha: 'd'.repeat(40),
      modelInputSha256: 'b'.repeat(64),
      environmentFingerprint: 'c'.repeat(64),
    },
    outcome: {
      requestedOutcomeMet: true,
      testsPassed: true,
      reviewFindingCounts: { p1: 0, p2: 0, p3: 0 },
      rollback: false,
      escapedRegression: false,
    },
    safety: { hardInvariantMisses: [], p1p2Escapes: 0 },
    harnessTax: {
      planContractAttempts: adaptive ? 1 : 'not_applicable',
      schemaRejections: adaptive ? 0 : 'not_applicable',
      semanticRejections: adaptive ? 0 : 'not_applicable',
      externalSchemaPatches: adaptive ? 0 : 'not_applicable',
      responseRepairs: adaptive ? 0 : 'not_applicable',
      planningTimeMs: 100,
      executionTimeMs: 300,
    },
    cost: {
      invocations: 1,
      toolCalls: 2,
      inputTokens: 1000,
      outputTokens: 400,
      wallTimeMs: 500,
      gateDurationMs: 50,
    },
    telemetryComplete: true,
    missingFields: [],
    ...overrides,
  });
}

function buildArtifact(overrides = {}) {
  const manifest = buildPilotManifest();
  return {
    schemaVersion: 'lf-0001.comparative-pilot.v1',
    pilotId: 'lf-0001-contained-code-pilot-001',
    pilotManifestSha256: fingerprintAdaptiveSopComparativePilotManifest(manifest),
    fixture: {
      fixtureId: 'contained-code-change',
      sourcePullRequest: 1,
      baseSha: 'a'.repeat(40),
      modelInputSha256: 'b'.repeat(64),
      environmentFingerprint: 'c'.repeat(64),
      mutatingWork: true,
      protectedSurface: false,
      objectiveOutcomeCheck: true,
    },
    controls: {
      trustedOutcomeHiddenFromExecutors: true,
      sameToolPermissions: true,
      sameHardGates: true,
      sameDataIsolation: true,
      sameReviewBoundary: true,
    },
    trials: ARMS.flatMap((arm) => [0, 1, 2].map((trialIndex) => buildTrial(arm, trialIndex))),
    ...overrides,
  };
}

function buildPilotManifest(overrides = {}) {
  return {
    schemaVersion: 'lf-0001.comparative-pilot-manifest.v1',
    pilotId: 'lf-0001-contained-code-pilot-001',
    fixtureId: 'contained-code-change',
    sourcePullRequest: 1,
    baseCommit: 'a'.repeat(40),
    modelInputSha256: 'b'.repeat(64),
    model: { provider: 'openai', modelId: 'gpt-5.6-sol' },
    fixture: {
      mutatingWork: true,
      protectedSurface: false,
      objectiveOutcomeCheck: true,
    },
    trialsPerArm: 3,
    arms: ARMS.map((id) => ({
      id,
      harnessVersion: id === 'adaptive_plan_hard_gates' ? 'lf-0001.adaptive-v1' : `lf-0001.${id}-v1`,
      planContract: id === 'adaptive_plan_hard_gates' ? 'lf-0001.plan-body-response.v2' : 'not_applicable',
      executionPolicy: `policy:${id}`,
    })),
    controls: {
      trustedOutcomeHiddenFromExecutors: true,
      sameToolPermissions: true,
      sameHardGates: true,
      sameDataIsolation: true,
      sameReviewBoundary: true,
      projection: 'executors receive only pinned model input',
    },
    comparability: {
      allowedChangedPaths: ['packages/api/test/telegram-html-formatter.test.js'],
      outcomeOracle: {
        id: 'focused-formatter-regression-v1',
        commandOrTool: 'node --test telegram-html-formatter.test.js',
        successExitCode: 0,
      },
      gatePolicy: {
        id: 'clowder-pre-review-gate-v1',
        commandOrTool: 'pnpm gate --no-rebase --skip-install',
        successExitCode: 0,
      },
      toolPermissionsPolicy: {
        id: 'isolated-code-trial-tools-v1',
        description: 'All arms receive the same repository and verification tool permissions.',
      },
      dataIsolationPolicy: {
        id: 'isolated-worktree-test-data-v1',
        description: 'All arms run in isolated worktrees without production user data.',
      },
      reviewBoundaryPolicy: {
        id: 'cross-individual-p1p2-clearance-v1',
        description: 'Every mutating trial requires cross-individual review and P1/P2 clearance.',
      },
    },
    requiredTrialEvidence: [
      'execution_provenance',
      'diff_and_verification',
      'review_and_outcome',
      'safety',
      'harness_tax',
      'telemetry',
    ],
    stopConditions: ['any hard-invariant miss'],
    notClaimed: ['No automatic promotion.'],
    ...overrides,
  };
}

function signTrial(trial) {
  const { evidenceReceipt: _evidenceReceipt, evidenceRefs: _evidenceRefs, ...payload } = trial;
  const manifestSha256 = fingerprintAdaptiveSopComparativePilotManifest(buildPilotManifest());
  const trialEvidenceSha256 = fingerprintAdaptiveSopComparativeTrialEvidence(payload);
  const resolvedEvidence = buildResolvedEvidence(payload);
  return {
    ...payload,
    evidenceReceipt: {
      schemaVersion: 'lf-0001.comparative-trial-receipt.v1',
      pilotManifestSha256: manifestSha256,
      trialEvidenceSha256,
      evidence: resolvedEvidence.map((evidence) => ({
        kind: evidence.kind,
        uri: evidenceUri(payload, evidence.kind),
        sha256: fingerprintAdaptiveSopComparativeResolvedEvidence(evidence),
      })),
    },
  };
}

function buildResolvedEvidence(trial) {
  const manifest = buildPilotManifest();
  const binding = {
    schemaVersion: 'lf-0001.comparative-evidence.v1',
    pilotId: 'lf-0001-contained-code-pilot-001',
    arm: trial.arm,
    trialIndex: trial.trialIndex,
    comparability: buildComparabilityFingerprints(manifest),
  };
  return [
    {
      ...binding,
      kind: 'execution_provenance',
      payload: {
        ...trial.provenance,
        model: trial.model,
        harnessVersion: trial.harnessVersion,
      },
    },
    {
      ...binding,
      kind: 'diff_and_verification',
      payload: {
        baseSha: trial.provenance.baseSha,
        finalSha: trial.provenance.finalSha,
        changedPaths: ['packages/api/test/telegram-html-formatter.test.js'],
        diffFingerprint: 'e'.repeat(64),
        outcomeOracle: {
          policyId: manifest.comparability.outcomeOracle.id,
          commandOrTool: manifest.comparability.outcomeOracle.commandOrTool,
          exitCode: trial.outcome.requestedOutcomeMet === true ? 0 : 1,
          evidenceSha256: '3'.repeat(64),
        },
        verification: [
          {
            commandOrTool: 'node --test telegram-html-formatter.test.js',
            exitCode: trial.outcome.testsPassed === true ? 0 : 1,
            evidenceSha256: 'f'.repeat(64),
          },
        ],
        gate: {
          policyId: manifest.comparability.gatePolicy.id,
          commandOrTool: manifest.comparability.gatePolicy.commandOrTool,
          exitCode: trial.outcome.testsPassed === true ? 0 : 1,
          finalSha: trial.provenance.finalSha,
          evidenceSha256: '1'.repeat(64),
        },
      },
    },
    {
      ...binding,
      kind: 'review_and_outcome',
      payload: {
        outcome: trial.outcome,
        review: {
          finalSha: trial.provenance.finalSha,
          authorId: 'cat-author',
          reviewerId: 'cat-reviewer',
          reviewArtifactSha256: '2'.repeat(64),
          p1p2Cleared: trial.outcome.reviewFindingCounts.p1 === 0 && trial.outcome.reviewFindingCounts.p2 === 0,
        },
      },
    },
    { ...binding, kind: 'safety', payload: trial.safety },
    { ...binding, kind: 'harness_tax', payload: trial.harnessTax },
    {
      ...binding,
      kind: 'telemetry',
      payload: {
        cost: trial.cost,
        telemetryComplete: trial.telemetryComplete,
        missingFields: trial.missingFields,
      },
    },
  ];
}

function buildComparabilityFingerprints(manifest) {
  return {
    allowedChangeEnvelopeSha256: fingerprintAdaptiveSopComparativePolicy(
      [...manifest.comparability.allowedChangedPaths].sort(),
    ),
    outcomeOraclePolicySha256: fingerprintAdaptiveSopComparativePolicy(manifest.comparability.outcomeOracle),
    gatePolicySha256: fingerprintAdaptiveSopComparativePolicy(manifest.comparability.gatePolicy),
    toolPermissionsPolicySha256: fingerprintAdaptiveSopComparativePolicy(manifest.comparability.toolPermissionsPolicy),
    dataIsolationPolicySha256: fingerprintAdaptiveSopComparativePolicy(manifest.comparability.dataIsolationPolicy),
    reviewBoundaryPolicySha256: fingerprintAdaptiveSopComparativePolicy(manifest.comparability.reviewBoundaryPolicy),
  };
}

function evidenceUri(trial, kind) {
  return `memory://trusted-runner/${trial.arm}/${trial.trialIndex}/${kind}`;
}

function buildEvidenceResolver(artifact, transform = (evidence) => evidence) {
  const store = new Map();
  for (const trial of artifact.trials) {
    for (const evidence of buildResolvedEvidence(trial)) {
      store.set(evidenceUri(trial, evidence.kind), transform(evidence));
    }
  }
  return { resolve: (reference) => store.get(reference.uri) };
}

describe('LF-0001 three-arm comparative pilot evidence', () => {
  it('accepts three comparable arms without turning the summary into an automatic promotion verdict', () => {
    const artifact = buildArtifact();
    const result = evaluateAdaptiveSopComparativePilot(artifact, buildPilotManifest(), buildEvidenceResolver(artifact));

    assert.equal(result.status, 'ready_for_operator_comparison');
    assert.equal(result.trialsPerArm, 3);
    assert.deepEqual(result.stopReasons, []);
    assert.deepEqual(result.incompleteReasons, []);
    assert.deepEqual(Object.keys(result.arms).sort(), [...ARMS].sort());
    assert.equal(result.arms.adaptive_plan_hard_gates.outcomeMetCount, 3);
    assert.equal(result.arms.adaptive_plan_hard_gates.externalSchemaPatchCount, 0);
    assert.deepEqual(result.arms.adaptive_plan_hard_gates.reviewFindingCounts, { p1: 0, p2: 0, p3: 0 });
    assert.equal(result.arms.adaptive_plan_hard_gates.knownPlanningTimeMs, 300);
    assert.equal(result.arms.adaptive_plan_hard_gates.knownCost.toolCalls, 6);
    assert.equal(Object.hasOwn(result, 'winner'), false);
    assert.equal(Object.hasOwn(result, 'promote'), false);
  });

  it('requires identical trial indices and at least three trials in every arm', () => {
    const missingAdaptiveTrial = buildArtifact({
      trials: buildArtifact().trials.filter(
        (trial) => !(trial.arm === 'adaptive_plan_hard_gates' && trial.trialIndex === 2),
      ),
    });

    assert.throws(
      () => evaluateAdaptiveSopComparativePilot(missingAdaptiveTrial, buildPilotManifest()),
      /every arm must contain the same trial indices and at least three trials/,
    );
  });

  it('requires one stable harness version within each arm', () => {
    const mixedAdaptiveHarness = buildArtifact().trials.map((trial) =>
      trial.arm === 'adaptive_plan_hard_gates' && trial.trialIndex === 2
        ? signTrial({ ...trial, harnessVersion: 'lf-0001.adaptive-v2' })
        : trial,
    );

    assert.throws(
      () => evaluateAdaptiveSopComparativePilot(buildArtifact({ trials: mixedAdaptiveHarness }), buildPilotManifest()),
      /every trial within an arm must use the same harness version/,
    );
  });

  it('stops on hard-invariant misses, escaped P1/P2, or adaptive response repair', () => {
    const trials = buildArtifact().trials.map((trial) => {
      if (trial.arm !== 'adaptive_plan_hard_gates' || trial.trialIndex !== 0) return trial;
      return signTrial({
        ...trial,
        safety: { hardInvariantMisses: ['protected-surface-miss'], p1p2Escapes: 1 },
        harnessTax: { ...trial.harnessTax, externalSchemaPatches: 1, responseRepairs: 1 },
      });
    });
    const artifact = buildArtifact({ trials });
    const result = evaluateAdaptiveSopComparativePilot(artifact, buildPilotManifest(), buildEvidenceResolver(artifact));

    assert.equal(result.status, 'stop');
    assert.ok(result.stopReasons.includes('hard invariant miss observed'));
    assert.ok(result.stopReasons.includes('P1/P2 escape observed'));
    assert.ok(result.stopReasons.includes('adaptive arm required an external response schema or repair'));
  });

  it('keeps missing telemetry visible and refuses comparison readiness', () => {
    const trials = buildArtifact().trials.map((trial) =>
      trial.arm === 'free_plan_hard_gates' && trial.trialIndex === 1
        ? signTrial({
            ...trial,
            cost: { ...trial.cost, inputTokens: 'missing' },
            telemetryComplete: false,
            missingFields: ['cost.inputTokens'],
          })
        : trial,
    );
    const artifact = buildArtifact({ trials });
    const result = evaluateAdaptiveSopComparativePilot(artifact, buildPilotManifest(), buildEvidenceResolver(artifact));

    assert.equal(result.status, 'insufficient_evidence');
    assert.ok(result.incompleteReasons.includes('one or more trials have incomplete telemetry or unknown outcomes'));
    assert.equal(result.arms.free_plan_hard_gates.incompleteTrialCount, 1);
  });

  it('rejects contract-only metrics on non-adaptive arms and not-applicable metrics on the adaptive arm', () => {
    const invalidFree = buildArtifact().trials.map((trial) =>
      trial.arm === 'free_plan_hard_gates' && trial.trialIndex === 0
        ? signTrial({ ...trial, harnessTax: { ...trial.harnessTax, schemaRejections: 0 } })
        : trial,
    );
    assert.throws(
      () => evaluateAdaptiveSopComparativePilot(buildArtifact({ trials: invalidFree }), buildPilotManifest()),
      /contract metrics must be not_applicable outside the adaptive arm/,
    );

    const invalidAdaptive = buildArtifact().trials.map((trial) =>
      trial.arm === 'adaptive_plan_hard_gates' && trial.trialIndex === 0
        ? signTrial({ ...trial, harnessTax: { ...trial.harnessTax, schemaRejections: 'not_applicable' } })
        : trial,
    );
    assert.throws(
      () => evaluateAdaptiveSopComparativePilot(buildArtifact({ trials: invalidAdaptive }), buildPilotManifest()),
      /adaptive contract metrics cannot be not_applicable/,
    );
  });

  it('binds fixture, model, controls, arms, and harness versions to an external pinned manifest', () => {
    const artifact = buildArtifact({
      fixture: { ...buildArtifact().fixture, sourcePullRequest: 999 },
    });

    assert.throws(
      () => evaluateAdaptiveSopComparativePilot(artifact, buildPilotManifest()),
      /source pull request must match the pinned pilot manifest/,
    );

    const wrongModelTrials = buildArtifact().trials.map((trial) =>
      signTrial({ ...trial, model: { provider: 'openai', modelId: 'other-model' } }),
    );
    assert.throws(
      () => evaluateAdaptiveSopComparativePilot(buildArtifact({ trials: wrongModelTrials }), buildPilotManifest()),
      /trial model identity must match the pinned pilot manifest/,
    );

    const wrongHarnessTrials = buildArtifact().trials.map((trial) =>
      trial.arm === 'adaptive_plan_hard_gates' ? signTrial({ ...trial, harnessVersion: 'lf-0001.adaptive-v2' }) : trial,
    );
    assert.throws(
      () => evaluateAdaptiveSopComparativePilot(buildArtifact({ trials: wrongHarnessTrials }), buildPilotManifest()),
      /harness version for adaptive_plan_hard_gates must match the pinned pilot manifest/,
    );
  });

  it('rejects self-asserted evidence strings without a manifest-bound content receipt', () => {
    const artifact = buildArtifact();
    artifact.trials[0] = {
      ...artifact.trials[0],
      evidenceReceipt: undefined,
      evidenceRefs: ['self-asserted'],
    };
    assert.throws(
      () => evaluateAdaptiveSopComparativePilot(artifact, buildPilotManifest()),
      /manifest-bound content receipt/,
    );
  });

  it('keeps self-signed receipts insufficient until an independent resolver verifies every evidence kind', () => {
    const artifact = buildArtifact();
    const unresolved = evaluateAdaptiveSopComparativePilot(artifact, buildPilotManifest());
    assert.equal(unresolved.status, 'insufficient_evidence');
    assert.ok(
      unresolved.incompleteReasons.includes('one or more trial evidence receipts were not independently resolved'),
    );

    artifact.trials[0] = {
      ...artifact.trials[0],
      evidenceReceipt: {
        ...artifact.trials[0].evidenceReceipt,
        evidence: artifact.trials[0].evidenceReceipt.evidence.slice(1),
      },
    };
    assert.throws(
      () => evaluateAdaptiveSopComparativePilot(artifact, buildPilotManifest()),
      /every evidence kind required by the pinned manifest exactly once/,
    );
  });

  it('keeps comparison insufficient when the independent resolver cannot load a referenced receipt', () => {
    const artifact = buildArtifact();
    const unresolved = evaluateAdaptiveSopComparativePilot(artifact, buildPilotManifest(), {
      resolve: () => undefined,
    });

    assert.equal(unresolved.status, 'insufficient_evidence');
    assert.ok(unresolved.incompleteReasons.includes('one or more trial evidence receipts could not be resolved'));
  });

  it('rejects resolver content that does not match its trusted fingerprint', () => {
    const artifact = buildArtifact();
    const resolver = buildEvidenceResolver(artifact, (evidence) =>
      evidence.kind === 'review_and_outcome'
        ? { ...evidence, payload: { ...evidence.payload, requestedOutcomeMet: false } }
        : evidence,
    );
    assert.throws(
      () => evaluateAdaptiveSopComparativePilot(artifact, buildPilotManifest(), resolver),
      /resolved review_and_outcome evidence does not match its content fingerprint/,
    );
  });

  it('rejects resolved review content that is validly hashed but contradicts the reported trial', () => {
    const artifact = buildArtifact();
    const target = artifact.trials[0];
    const transform = (evidence) =>
      evidence.kind === 'review_and_outcome' && evidence.arm === target.arm && evidence.trialIndex === target.trialIndex
        ? {
            ...evidence,
            payload: {
              ...evidence.payload,
              outcome: { ...evidence.payload.outcome, requestedOutcomeMet: false },
            },
          }
        : evidence;
    const mismatchedReview = transform(
      buildResolvedEvidence(target).find((evidence) => evidence.kind === 'review_and_outcome'),
    );
    artifact.trials[0] = {
      ...target,
      evidenceReceipt: {
        ...target.evidenceReceipt,
        evidence: target.evidenceReceipt.evidence.map((reference) =>
          reference.kind === 'review_and_outcome'
            ? { ...reference, sha256: fingerprintAdaptiveSopComparativeResolvedEvidence(mismatchedReview) }
            : reference,
        ),
      },
    };

    assert.throws(
      () =>
        evaluateAdaptiveSopComparativePilot(artifact, buildPilotManifest(), buildEvidenceResolver(artifact, transform)),
      /resolved review_and_outcome evidence does not match the comparative trial/,
    );
  });

  it('rejects a validly hashed failed gate receipt when the trial reports passing tests', () => {
    const artifact = buildArtifact();
    const target = artifact.trials[0];
    const transform = (evidence) =>
      evidence.kind === 'diff_and_verification' &&
      evidence.arm === target.arm &&
      evidence.trialIndex === target.trialIndex
        ? {
            ...evidence,
            payload: {
              ...evidence.payload,
              gate: { ...evidence.payload.gate, exitCode: 1 },
            },
          }
        : evidence;
    const failedGate = transform(
      buildResolvedEvidence(target).find((evidence) => evidence.kind === 'diff_and_verification'),
    );
    artifact.trials[0] = {
      ...target,
      evidenceReceipt: {
        ...target.evidenceReceipt,
        evidence: target.evidenceReceipt.evidence.map((reference) =>
          reference.kind === 'diff_and_verification'
            ? { ...reference, sha256: fingerprintAdaptiveSopComparativeResolvedEvidence(failedGate) }
            : reference,
        ),
      },
    };

    assert.throws(
      () =>
        evaluateAdaptiveSopComparativePilot(artifact, buildPilotManifest(), buildEvidenceResolver(artifact, transform)),
      /resolved diff or verification evidence does not match the comparative trial/,
    );
  });

  it('rejects a validly hashed diff that escapes the pinned test-only change envelope', () => {
    const artifact = buildArtifact();
    const target = artifact.trials.find((trial) => trial.arm === 'adaptive_plan_hard_gates' && trial.trialIndex === 0);
    const transform = (evidence) =>
      evidence.kind === 'diff_and_verification' &&
      evidence.arm === target.arm &&
      evidence.trialIndex === target.trialIndex
        ? {
            ...evidence,
            payload: {
              ...evidence.payload,
              changedPaths: ['packages/api/src/runtime-escape.ts'],
            },
          }
        : evidence;
    const escapedDiff = transform(
      buildResolvedEvidence(target).find((evidence) => evidence.kind === 'diff_and_verification'),
    );
    artifact.trials = artifact.trials.map((trial) =>
      trial === target
        ? {
            ...trial,
            evidenceReceipt: {
              ...trial.evidenceReceipt,
              evidence: trial.evidenceReceipt.evidence.map((reference) =>
                reference.kind === 'diff_and_verification'
                  ? { ...reference, sha256: fingerprintAdaptiveSopComparativeResolvedEvidence(escapedDiff) }
                  : reference,
              ),
            },
          }
        : trial,
    );

    assert.throws(
      () =>
        evaluateAdaptiveSopComparativePilot(artifact, buildPilotManifest(), buildEvidenceResolver(artifact, transform)),
      /outside the pinned allowed change envelope/,
    );
  });

  it('rejects a validly hashed receipt whose cross-arm control fingerprints diverge from the manifest', () => {
    const artifact = buildArtifact();
    const target = artifact.trials[0];
    const transform = (evidence) =>
      evidence.kind === 'execution_provenance' &&
      evidence.arm === target.arm &&
      evidence.trialIndex === target.trialIndex
        ? {
            ...evidence,
            comparability: {
              ...evidence.comparability,
              toolPermissionsPolicySha256: '9'.repeat(64),
            },
          }
        : evidence;
    const divergentControls = transform(
      buildResolvedEvidence(target).find((evidence) => evidence.kind === 'execution_provenance'),
    );
    artifact.trials[0] = {
      ...target,
      evidenceReceipt: {
        ...target.evidenceReceipt,
        evidence: target.evidenceReceipt.evidence.map((reference) =>
          reference.kind === 'execution_provenance'
            ? { ...reference, sha256: fingerprintAdaptiveSopComparativeResolvedEvidence(divergentControls) }
            : reference,
        ),
      },
    };

    assert.throws(
      () =>
        evaluateAdaptiveSopComparativePilot(artifact, buildPilotManifest(), buildEvidenceResolver(artifact, transform)),
      /comparability controls do not match the pinned pilot manifest/,
    );
  });

  it('rejects a validly hashed outcome oracle that differs from the pinned cross-arm policy', () => {
    const artifact = buildArtifact();
    const target = artifact.trials[0];
    const transform = (evidence) =>
      evidence.kind === 'diff_and_verification' &&
      evidence.arm === target.arm &&
      evidence.trialIndex === target.trialIndex
        ? {
            ...evidence,
            payload: {
              ...evidence.payload,
              outcomeOracle: { ...evidence.payload.outcomeOracle, commandOrTool: 'forged-outcome-oracle' },
            },
          }
        : evidence;
    const divergentOracle = transform(
      buildResolvedEvidence(target).find((evidence) => evidence.kind === 'diff_and_verification'),
    );
    artifact.trials[0] = {
      ...target,
      evidenceReceipt: {
        ...target.evidenceReceipt,
        evidence: target.evidenceReceipt.evidence.map((reference) =>
          reference.kind === 'diff_and_verification'
            ? { ...reference, sha256: fingerprintAdaptiveSopComparativeResolvedEvidence(divergentOracle) }
            : reference,
        ),
      },
    };

    assert.throws(
      () =>
        evaluateAdaptiveSopComparativePilot(artifact, buildPilotManifest(), buildEvidenceResolver(artifact, transform)),
      /resolved diff or verification evidence does not match the comparative trial/,
    );
  });

  it('rejects a validly hashed review receipt without cross-individual clearance', () => {
    const artifact = buildArtifact();
    const target = artifact.trials[0];
    const transform = (evidence) =>
      evidence.kind === 'review_and_outcome' && evidence.arm === target.arm && evidence.trialIndex === target.trialIndex
        ? {
            ...evidence,
            payload: {
              ...evidence.payload,
              review: { ...evidence.payload.review, reviewerId: evidence.payload.review.authorId },
            },
          }
        : evidence;
    const sameIndividualReview = transform(
      buildResolvedEvidence(target).find((evidence) => evidence.kind === 'review_and_outcome'),
    );
    artifact.trials[0] = {
      ...target,
      evidenceReceipt: {
        ...target.evidenceReceipt,
        evidence: target.evidenceReceipt.evidence.map((reference) =>
          reference.kind === 'review_and_outcome'
            ? { ...reference, sha256: fingerprintAdaptiveSopComparativeResolvedEvidence(sameIndividualReview) }
            : reference,
        ),
      },
    };

    assert.throws(
      () =>
        evaluateAdaptiveSopComparativePilot(artifact, buildPilotManifest(), buildEvidenceResolver(artifact, transform)),
      /resolved review evidence does not preserve cross-individual P1\/P2 clearance/,
    );
  });

  it('rejects a receipt that does not fingerprint the exact trial evidence', () => {
    const artifact = buildArtifact();
    artifact.trials[0] = {
      ...artifact.trials[0],
      outcome: { ...artifact.trials[0].outcome, requestedOutcomeMet: false },
    };

    assert.throws(
      () => evaluateAdaptiveSopComparativePilot(artifact, buildPilotManifest()),
      /trial receipt fingerprint does not match/,
    );
  });
});
