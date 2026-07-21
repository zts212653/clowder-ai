import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateAdaptiveSopComparativePilot,
  fingerprintAdaptiveSopComparativePilotManifest,
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
    requiredTrialEvidence: ['content-addressed execution receipt'],
    stopConditions: ['any hard-invariant miss'],
    notClaimed: ['No automatic promotion.'],
    ...overrides,
  };
}

function signTrial(trial) {
  const { evidenceReceipt: _evidenceReceipt, evidenceRefs: _evidenceRefs, ...payload } = trial;
  const manifestSha256 = fingerprintAdaptiveSopComparativePilotManifest(buildPilotManifest());
  const trialEvidenceSha256 = fingerprintAdaptiveSopComparativeTrialEvidence(payload);
  return {
    ...payload,
    evidenceReceipt: {
      schemaVersion: 'lf-0001.comparative-trial-receipt.v1',
      pilotManifestSha256: manifestSha256,
      trialEvidenceSha256,
      evidence: [
        {
          uri: `https://evidence.invalid/lf-0001/${payload.arm}/${payload.trialIndex}`,
          sha256: trialEvidenceSha256,
        },
      ],
    },
  };
}

describe('LF-0001 three-arm comparative pilot evidence', () => {
  it('accepts three comparable arms without turning the summary into an automatic promotion verdict', () => {
    const result = evaluateAdaptiveSopComparativePilot(buildArtifact(), buildPilotManifest());

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
    const result = evaluateAdaptiveSopComparativePilot(buildArtifact({ trials }), buildPilotManifest());

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
    const result = evaluateAdaptiveSopComparativePilot(buildArtifact({ trials }), buildPilotManifest());

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
      () =>
        evaluateAdaptiveSopComparativePilot(buildArtifact({ trials: wrongModelTrials }), buildPilotManifest()),
      /trial model identity must match the pinned pilot manifest/,
    );

    const wrongHarnessTrials = buildArtifact().trials.map((trial) =>
      trial.arm === 'adaptive_plan_hard_gates'
        ? signTrial({ ...trial, harnessVersion: 'lf-0001.adaptive-v2' })
        : trial,
    );
    assert.throws(
      () =>
        evaluateAdaptiveSopComparativePilot(buildArtifact({ trials: wrongHarnessTrials }), buildPilotManifest()),
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
