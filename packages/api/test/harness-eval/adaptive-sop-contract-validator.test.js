import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AdaptiveSopContractError,
  parseAdaptiveSopPlan,
  parseSopAdmissionDecision,
  parseSopTrialEpisode,
} from '../../dist/infrastructure/harness-eval/sop/adaptive-sop-contract.js';

const validPlan = {
  schemaVersion: 'adaptive-sop-plan.v1',
  episodeId: 'episode-001',
  model: { provider: 'openai', modelId: 'gpt-5.6-sol', harnessVersion: 'lf-0001.v1' },
  taskUnderstanding: 'Produce a provenance-backed replay manifest without enabling runtime behavior.',
  desiredOutcome: ['The planner cannot see grader-only outcomes.'],
  repositoryFacts: {
    worktreeRoot: '/tmp/clowder-adaptive-sop',
    branch: 'feat/F192-lf-0001-adaptive-sop',
    baseSha: 'd5961fe3974cf568b6bd080b0024eb97774ea53b',
    changedFiles: ['packages/api/test/harness-eval/adaptive-sop-replay-manifest.test.js'],
    diffFingerprint: 'a'.repeat(64),
  },
  risks: [
    {
      claim: 'Historical outcomes could leak into planner context.',
      evidence: ['Planner and grader data share one manifest.'],
      uncertainty: [],
    },
  ],
  decisions: [
    {
      stepId: 'targeted-contract-test',
      action: 'include',
      reason: 'The projection boundary needs executable regression evidence.',
      residualRisk: 'Runner wiring remains outside this slice.',
    },
    {
      stepId: 'runtime-restart',
      action: 'omit',
      reason: 'No runtime module changes in this slice.',
      residualRisk: 'End-to-end wiring remains untested.',
      replacementEvidence: ['Static diff plus targeted schema test.'],
    },
  ],
  executionOrder: ['targeted-contract-test'],
  outcomeChecks: ['The contract test rejects grader-only leakage.'],
  replanTriggers: ['A production module enters the diff.'],
  rollbackPlan: 'Revert the single commit.',
};

const admitted = {
  schemaVersion: 'sop-admission-decision.v1',
  status: 'admitted',
  episodeId: 'episode-001',
  envelopeFingerprint: 'b'.repeat(64),
};

function validEpisode() {
  return {
    schemaVersion: 'sop-trial-episode.v1',
    plan: validPlan,
    admission: admitted,
    actualSteps: [
      {
        stage: 'quality_gate',
        commandOrTool: 'node --test adaptive-sop-contract-validator.test.js',
        startedAt: '2026-07-21T01:00:00.000Z',
        completedAt: '2026-07-21T01:00:01.000Z',
        exitCode: 0,
        evidenceRef: 'test:adaptive-sop-contract-validator',
      },
    ],
    outcome: {
      requestedOutcomeMet: true,
      testsPassed: true,
      reviewFindingCounts: { p1: 0, p2: 0, p3: 0 },
      operatorCorrection: false,
      rollback: false,
      escapedRegression: false,
    },
    cost: {
      invocations: 1,
      toolCalls: 3,
      inputTokens: 1200,
      outputTokens: 500,
      wallTimeMs: 1000,
      gateDurationMs: 500,
    },
    telemetryComplete: true,
    missingFields: [],
  };
}

function assertContractError(fn, code) {
  assert.throws(fn, (error) => error instanceof AdaptiveSopContractError && error.code === code);
}

describe('LF-0001 adaptive SOP semantic contract validator', () => {
  it('parses a semantically valid plan and admitted decision', () => {
    assert.deepEqual(parseAdaptiveSopPlan(validPlan), validPlan);
    assert.deepEqual(parseSopAdmissionDecision(admitted), admitted);
  });

  it('reports unsupported schema versions separately from malformed input', () => {
    assertContractError(
      () => parseAdaptiveSopPlan({ ...validPlan, schemaVersion: 'adaptive-sop-plan.v2' }),
      'unsupported_schema_version',
    );
    assertContractError(() => parseAdaptiveSopPlan({ ...validPlan, taskUnderstanding: '' }), 'invalid_contract');
  });

  it('requires alternative evidence for omitted or replaced steps', () => {
    const decisions = validPlan.decisions.map((decision) =>
      decision.action === 'omit' ? { ...decision, replacementEvidence: [] } : decision,
    );
    assertContractError(() => parseAdaptiveSopPlan({ ...validPlan, decisions }), 'semantic_invariant_violation');
  });

  it('rejects risk claims with neither evidence nor explicit uncertainty', () => {
    assertContractError(
      () =>
        parseAdaptiveSopPlan({
          ...validPlan,
          risks: [{ claim: 'This might be low risk.', evidence: [], uncertainty: [] }],
        }),
      'semantic_invariant_violation',
    );
  });

  it('requires executionOrder to contain every non-omitted step exactly once', () => {
    assertContractError(
      () =>
        parseAdaptiveSopPlan({ ...validPlan, executionOrder: ['targeted-contract-test', 'targeted-contract-test'] }),
      'semantic_invariant_violation',
    );
    assertContractError(
      () => parseAdaptiveSopPlan({ ...validPlan, executionOrder: ['targeted-contract-test', 'runtime-restart'] }),
      'semantic_invariant_violation',
    );
  });

  it('requires admitted episode identity and step time order to match reality', () => {
    assertContractError(
      () => parseSopTrialEpisode({ ...validEpisode(), admission: { ...admitted, episodeId: 'other-episode' } }),
      'semantic_invariant_violation',
    );
    const episode = validEpisode();
    episode.actualSteps[0] = {
      ...episode.actualSteps[0],
      startedAt: '2026-07-21T01:00:02.000Z',
      completedAt: '2026-07-21T01:00:01.000Z',
    };
    assertContractError(() => parseSopTrialEpisode(episode), 'semantic_invariant_violation');
  });

  it('keeps telemetryComplete consistent with missing values and paths', () => {
    const episode = validEpisode();
    episode.cost.inputTokens = 'missing';
    assertContractError(() => parseSopTrialEpisode(episode), 'semantic_invariant_violation');

    const incomplete = validEpisode();
    incomplete.telemetryComplete = false;
    incomplete.missingFields = [];
    assertContractError(() => parseSopTrialEpisode(incomplete), 'semantic_invariant_violation');
  });
});
