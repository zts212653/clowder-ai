import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateSopAdmission,
  parseSopAdmissionFacts,
} from '../../dist/infrastructure/harness-eval/sop/adaptive-sop-admission.js';
import { AdaptiveSopContractError } from '../../dist/infrastructure/harness-eval/sop/adaptive-sop-contract.js';

const validPlan = {
  schemaVersion: 'adaptive-sop-plan.v1',
  episodeId: 'episode-admission-001',
  model: { provider: 'openai', modelId: 'gpt-5.6-sol', harnessVersion: 'lf-0001.v1' },
  taskUnderstanding: 'Add a static replay contract in an isolated feature worktree.',
  desiredOutcome: ['The replay contract is validated without changing runtime behavior.'],
  repositoryFacts: {
    worktreeRoot: '/tmp/clowder-adaptive-sop',
    branch: 'feat/F192-lf-0001-adaptive-sop',
    baseSha: 'd5961fe3974cf568b6bd080b0024eb97774ea53b',
    changedFiles: ['packages/api/test/harness-eval/adaptive-sop-admission.test.js'],
    diffFingerprint: 'a'.repeat(64),
  },
  risks: [
    {
      claim: 'The evaluator could trust model-authored risk flags.',
      evidence: ['Admission facts are supplied through a separate input.'],
      uncertainty: [],
    },
  ],
  decisions: [
    {
      stepId: 'targeted-test',
      action: 'include',
      reason: 'The independent facts boundary needs a regression test.',
      residualRisk: 'No end-to-end runtime wiring exists yet.',
    },
  ],
  executionOrder: ['targeted-test'],
  outcomeChecks: ['The evaluator returns a deterministic structured decision.'],
  replanTriggers: ['The observed diff enters a protected surface.'],
  rollbackPlan: 'Revert the single feature commit.',
};

const validFacts = {
  schemaVersion: 'sop-admission-facts.v1',
  episodeId: 'episode-admission-001',
  observedAt: '2026-07-21T02:00:00.000Z',
  repository: {
    worktreeRoot: '/tmp/clowder-adaptive-sop',
    branch: 'feat/F192-lf-0001-adaptive-sop',
    baseSha: 'd5961fe3974cf568b6bd080b0024eb97774ea53b',
    changedFiles: ['packages/api/test/harness-eval/adaptive-sop-admission.test.js'],
    diffFingerprint: 'a'.repeat(64),
    isolatedWorktree: true,
    recoveryWithinOneCommit: true,
  },
  data: {
    testDataIsolated: true,
    productionUserDataInScope: false,
  },
  effects: {
    externalUserEffect: false,
    destructiveOrIrreversible: false,
    authDelta: false,
    persistentDataDelta: false,
    runtimeDelta: false,
    permissionDelta: false,
    publicContractDelta: false,
    newExternalDependency: false,
    significantCost: false,
  },
  verification: {
    objectiveOutcomeCheck: true,
    mutatingWork: true,
    crossIndividualReviewPlanned: true,
    p1p2ClearancePlanned: true,
  },
};

describe('LF-0001 deterministic SOP admission envelope', () => {
  it('admits only independently verified facts and returns a stable fingerprint', () => {
    const first = evaluateSopAdmission(validPlan, validFacts);
    const laterObservation = evaluateSopAdmission(validPlan, {
      ...validFacts,
      observedAt: '2026-07-21T02:05:00.000Z',
      repository: {
        ...validFacts.repository,
        changedFiles: [...validFacts.repository.changedFiles].reverse(),
      },
    });

    assert.equal(first.status, 'admitted');
    assert.match(first.envelopeFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(laterObservation.status, 'admitted');
    assert.equal(laterObservation.envelopeFingerprint, first.envelopeFingerprint);

    const changedDiff = evaluateSopAdmission(validPlan, {
      ...validFacts,
      repository: { ...validFacts.repository, diffFingerprint: 'c'.repeat(64) },
    });
    assert.equal(changedDiff.status, 'blocked', 'a contradictory actual diff must not reuse admission');
  });

  it('returns revise for unknown facts instead of treating them as false', () => {
    const decision = evaluateSopAdmission(validPlan, {
      ...validFacts,
      repository: { ...validFacts.repository, diffFingerprint: 'unknown' },
      effects: { ...validFacts.effects, authDelta: 'unknown' },
    });

    assert.equal(decision.status, 'revise');
    assert.equal(decision.episodeId, validPlan.episodeId);
    assert.match(decision.envelopeFingerprint, /^[0-9a-f]{64}$/);
    assert.ok(decision.requiredFacts.includes('repository.diffFingerprint'));
    assert.ok(decision.requiredFacts.includes('effects.authDelta'));
  });

  it('blocks on protected facts even when the plan does not claim the risk', () => {
    const decision = evaluateSopAdmission(validPlan, {
      ...validFacts,
      effects: { ...validFacts.effects, authDelta: true },
    });

    assert.equal(decision.schemaVersion, 'sop-admission-decision.v1');
    assert.equal(decision.status, 'blocked');
    assert.equal(decision.episodeId, validPlan.episodeId);
    assert.match(decision.envelopeFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(decision.invariant, 'protected surface: effects.authDelta');
    assert.equal(decision.fallback, 'operator');
  });

  it('falls back to the full SOP outside worktree or rollback containment', () => {
    for (const repository of [
      { ...validFacts.repository, isolatedWorktree: false },
      { ...validFacts.repository, recoveryWithinOneCommit: false },
    ]) {
      const decision = evaluateSopAdmission(validPlan, { ...validFacts, repository });
      assert.equal(decision.status, 'blocked');
      assert.equal(decision.fallback, 'full_sop');
    }
  });

  it('blocks contradictory model repository facts against observed facts', () => {
    const decision = evaluateSopAdmission(
      {
        ...validPlan,
        repositoryFacts: { ...validPlan.repositoryFacts, branch: 'main' },
      },
      validFacts,
    );

    assert.equal(decision.schemaVersion, 'sop-admission-decision.v1');
    assert.equal(decision.status, 'blocked');
    assert.equal(decision.episodeId, validPlan.episodeId);
    assert.match(decision.envelopeFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(decision.invariant, 'contradictory repository fact: branch');
    assert.equal(decision.fallback, 'full_sop');
  });

  it('requires objective verification and mutating-work review plans', () => {
    const decision = evaluateSopAdmission(validPlan, {
      ...validFacts,
      verification: {
        ...validFacts.verification,
        objectiveOutcomeCheck: false,
        crossIndividualReviewPlanned: false,
      },
    });

    assert.equal(decision.status, 'revise');
    assert.ok(decision.violations.includes('objective outcome check is not established'));
    assert.ok(decision.violations.includes('cross-individual review is not planned'));
  });

  it('accepts not-applicable test data isolation but rejects production data scope', () => {
    const docsDecision = evaluateSopAdmission(validPlan, {
      ...validFacts,
      data: { ...validFacts.data, testDataIsolated: 'not_applicable' },
    });
    assert.equal(docsDecision.status, 'admitted');

    const productionDecision = evaluateSopAdmission(validPlan, {
      ...validFacts,
      data: { ...validFacts.data, productionUserDataInScope: true },
    });
    assert.equal(productionDecision.status, 'blocked');
    assert.equal(productionDecision.fallback, 'operator');
  });

  it('reports fact schema upgrades explicitly', () => {
    assert.throws(
      () => parseSopAdmissionFacts({ ...validFacts, schemaVersion: 'sop-admission-facts.v2' }),
      (error) => error instanceof AdaptiveSopContractError && error.code === 'unsupported_schema_version',
    );
  });
});
