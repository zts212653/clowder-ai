import { describe, expect, it } from 'vitest';
import {
  ADAPTIVE_SOP_PLAN_SCHEMA_VERSION,
  type AdaptiveSopPlan,
  AdaptiveSopPlanSchema,
  SOP_ADMISSION_DECISION_SCHEMA_VERSION,
  SOP_TRIAL_EPISODE_SCHEMA_VERSION,
  SopAdmissionDecisionSchema,
  SopTrialEpisodeSchema,
} from '../schemas/adaptive-sop.js';

const validAdaptiveSopPlan: AdaptiveSopPlan = {
  schemaVersion: ADAPTIVE_SOP_PLAN_SCHEMA_VERSION,
  episodeId: 'episode-001',
  model: {
    provider: 'openai',
    modelId: 'gpt-5.6-sol',
    harnessVersion: 'lf-0001.v1',
  },
  taskUnderstanding: 'Add a leakage-safe historical replay manifest before enabling adaptive execution.',
  desiredOutcome: ['The replay bank is provenance-backed and does not expose grader-only outcomes.'],
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
      evidence: ['The manifest stores planner and grader data as siblings.'],
      uncertainty: [],
    },
  ],
  decisions: [
    {
      stepId: 'targeted-contract-test',
      action: 'include',
      reason: 'The projection boundary needs executable regression evidence.',
      residualRisk: 'The test cannot prove runner wiring that does not exist yet.',
    },
    {
      stepId: 'runtime-restart',
      action: 'omit',
      reason: 'This slice changes static test artifacts only.',
      residualRisk: 'Runtime wiring remains untested until Slice C.',
      replacementEvidence: ['Schema test plus repository check; no runtime module changes.'],
    },
  ],
  executionOrder: ['targeted-contract-test'],
  outcomeChecks: ['The contract test rejects grader-only leakage and malformed provenance.'],
  replanTriggers: ['Any production module enters the diff.'],
  rollbackPlan: 'Revert the single feature commit and retain the failed fixture as evidence.',
};

describe('LF-0001 adaptive SOP shared schemas', () => {
  it('parses a strict v1 AdaptiveSopPlan', () => {
    const parsed = AdaptiveSopPlanSchema.parse(validAdaptiveSopPlan);
    expect(parsed.schemaVersion).toBe('adaptive-sop-plan.v1');
    expect(parsed.decisions).toHaveLength(2);
  });

  it('rejects missing, old, future, and unknown plan fields', () => {
    const { schemaVersion: _schemaVersion, ...withoutVersion } = validAdaptiveSopPlan;
    expect(AdaptiveSopPlanSchema.safeParse(withoutVersion).success).toBe(false);
    expect(
      AdaptiveSopPlanSchema.safeParse({ ...validAdaptiveSopPlan, schemaVersion: 'adaptive-sop-plan.v0' }).success,
    ).toBe(false);
    expect(
      AdaptiveSopPlanSchema.safeParse({ ...validAdaptiveSopPlan, schemaVersion: 'adaptive-sop-plan.v2' }).success,
    ).toBe(false);
    expect(AdaptiveSopPlanSchema.safeParse({ ...validAdaptiveSopPlan, lane: 'quick' }).success).toBe(false);
    expect(
      AdaptiveSopPlanSchema.safeParse({
        ...validAdaptiveSopPlan,
        model: { ...validAdaptiveSopPlan.model, hiddenCapability: true },
      }).success,
    ).toBe(false);
  });

  it('parses all admission decision variants with one version', () => {
    for (const decision of [
      {
        schemaVersion: SOP_ADMISSION_DECISION_SCHEMA_VERSION,
        status: 'admitted',
        episodeId: 'episode-001',
        envelopeFingerprint: 'b'.repeat(64),
      },
      {
        schemaVersion: SOP_ADMISSION_DECISION_SCHEMA_VERSION,
        status: 'revise',
        episodeId: 'episode-001',
        envelopeFingerprint: 'c'.repeat(64),
        violations: ['worktree isolation is unknown'],
        requiredFacts: ['worktreeRoot'],
      },
      {
        schemaVersion: SOP_ADMISSION_DECISION_SCHEMA_VERSION,
        status: 'blocked',
        episodeId: 'episode-001',
        envelopeFingerprint: 'd'.repeat(64),
        invariant: 'production data is in scope',
        fallback: 'operator',
      },
    ]) {
      expect(SopAdmissionDecisionSchema.safeParse(decision).success).toBe(true);
    }
  });

  it('rejects revise and blocked decisions without episode and facts bindings', () => {
    for (const decision of [
      {
        schemaVersion: SOP_ADMISSION_DECISION_SCHEMA_VERSION,
        status: 'revise',
        violations: ['worktree isolation is unknown'],
        requiredFacts: ['worktreeRoot'],
      },
      {
        schemaVersion: SOP_ADMISSION_DECISION_SCHEMA_VERSION,
        status: 'blocked',
        invariant: 'production data is in scope',
        fallback: 'operator',
      },
    ]) {
      expect(SopAdmissionDecisionSchema.safeParse(decision).success).toBe(false);
    }
  });

  it('preserves missing episode metrics instead of coercing them to zero', () => {
    const parsed = SopTrialEpisodeSchema.parse({
      schemaVersion: SOP_TRIAL_EPISODE_SCHEMA_VERSION,
      plan: validAdaptiveSopPlan,
      admission: {
        schemaVersion: SOP_ADMISSION_DECISION_SCHEMA_VERSION,
        status: 'revise',
        episodeId: 'episode-001',
        envelopeFingerprint: 'c'.repeat(64),
        violations: ['diff fingerprint is missing'],
        requiredFacts: ['repositoryFacts.diffFingerprint'],
      },
      actualSteps: [],
      outcome: {
        requestedOutcomeMet: 'unknown',
        testsPassed: 'not_applicable',
        reviewFindingCounts: { p1: 0, p2: 0, p3: 0 },
        operatorCorrection: false,
        rollback: false,
        escapedRegression: 'unknown',
      },
      cost: {
        invocations: 'missing',
        toolCalls: 'missing',
        inputTokens: 'missing',
        outputTokens: 'missing',
        wallTimeMs: 'missing',
        gateDurationMs: 'missing',
      },
      telemetryComplete: false,
      missingFields: [
        'outcome.requestedOutcomeMet',
        'outcome.escapedRegression',
        'cost.invocations',
        'cost.toolCalls',
        'cost.inputTokens',
        'cost.outputTokens',
        'cost.wallTimeMs',
        'cost.gateDurationMs',
      ],
    });

    expect(parsed.cost.invocations).toBe('missing');
    expect(parsed.telemetryComplete).toBe(false);
  });
});
