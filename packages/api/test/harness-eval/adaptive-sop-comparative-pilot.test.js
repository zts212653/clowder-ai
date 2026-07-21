import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateAdaptiveSopComparativePilot } from '../../dist/infrastructure/harness-eval/sop/adaptive-sop-comparative-pilot.js';

const ARMS = ['full_sop', 'free_plan_hard_gates', 'adaptive_plan_hard_gates'];

function buildTrial(arm, trialIndex, overrides = {}) {
  const adaptive = arm === 'adaptive_plan_hard_gates';
  return {
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
    evidenceRefs: [`artifact:${arm}:${trialIndex}`],
    ...overrides,
  };
}

function buildArtifact(overrides = {}) {
  return {
    schemaVersion: 'lf-0001.comparative-pilot.v1',
    pilotId: 'lf-0001-contained-code-pilot-001',
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

describe('LF-0001 three-arm comparative pilot evidence', () => {
  it('accepts three comparable arms without turning the summary into an automatic promotion verdict', () => {
    const result = evaluateAdaptiveSopComparativePilot(buildArtifact());

    assert.equal(result.status, 'ready_for_operator_comparison');
    assert.equal(result.trialsPerArm, 3);
    assert.deepEqual(result.stopReasons, []);
    assert.deepEqual(result.incompleteReasons, []);
    assert.deepEqual(Object.keys(result.arms).sort(), [...ARMS].sort());
    assert.equal(result.arms.adaptive_plan_hard_gates.outcomeMetCount, 3);
    assert.equal(result.arms.adaptive_plan_hard_gates.externalSchemaPatchCount, 0);
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
      () => evaluateAdaptiveSopComparativePilot(missingAdaptiveTrial),
      /every arm must contain the same trial indices and at least three trials/,
    );
  });

  it('stops on hard-invariant misses, escaped P1/P2, or adaptive response repair', () => {
    const trials = buildArtifact().trials.map((trial) => {
      if (trial.arm !== 'adaptive_plan_hard_gates' || trial.trialIndex !== 0) return trial;
      return {
        ...trial,
        safety: { hardInvariantMisses: ['protected-surface-miss'], p1p2Escapes: 1 },
        harnessTax: { ...trial.harnessTax, externalSchemaPatches: 1, responseRepairs: 1 },
      };
    });
    const result = evaluateAdaptiveSopComparativePilot(buildArtifact({ trials }));

    assert.equal(result.status, 'stop');
    assert.ok(result.stopReasons.includes('hard invariant miss observed'));
    assert.ok(result.stopReasons.includes('P1/P2 escape observed'));
    assert.ok(result.stopReasons.includes('adaptive arm required an external response schema or repair'));
  });

  it('keeps missing telemetry visible and refuses comparison readiness', () => {
    const trials = buildArtifact().trials.map((trial) =>
      trial.arm === 'free_plan_hard_gates' && trial.trialIndex === 1
        ? {
            ...trial,
            cost: { ...trial.cost, inputTokens: 'missing' },
            telemetryComplete: false,
            missingFields: ['cost.inputTokens'],
          }
        : trial,
    );
    const result = evaluateAdaptiveSopComparativePilot(buildArtifact({ trials }));

    assert.equal(result.status, 'insufficient_evidence');
    assert.ok(result.incompleteReasons.includes('one or more trials have incomplete telemetry or unknown outcomes'));
    assert.equal(result.arms.free_plan_hard_gates.incompleteTrialCount, 1);
  });

  it('rejects contract-only metrics on non-adaptive arms and not-applicable metrics on the adaptive arm', () => {
    const invalidFree = buildArtifact().trials.map((trial) =>
      trial.arm === 'free_plan_hard_gates' && trial.trialIndex === 0
        ? { ...trial, harnessTax: { ...trial.harnessTax, schemaRejections: 0 } }
        : trial,
    );
    assert.throws(
      () => evaluateAdaptiveSopComparativePilot(buildArtifact({ trials: invalidFree })),
      /contract metrics must be not_applicable outside the adaptive arm/,
    );

    const invalidAdaptive = buildArtifact().trials.map((trial) =>
      trial.arm === 'adaptive_plan_hard_gates' && trial.trialIndex === 0
        ? { ...trial, harnessTax: { ...trial.harnessTax, schemaRejections: 'not_applicable' } }
        : trial,
    );
    assert.throws(
      () => evaluateAdaptiveSopComparativePilot(buildArtifact({ trials: invalidAdaptive })),
      /adaptive contract metrics cannot be not_applicable/,
    );
  });
});
