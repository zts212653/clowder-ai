import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runAdaptiveSopReplay } from '../../dist/infrastructure/harness-eval/sop/adaptive-sop-replay-runner.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(here, 'fixtures');
const manifest = JSON.parse(readFileSync(join(fixturesRoot, 'adaptive-sop-replay-manifest.json'), 'utf8'));
const rubric = JSON.parse(readFileSync(join(fixturesRoot, 'adaptive-sop-grader-rubric.json'), 'utf8'));

const plannerIdentity = {
  adapterId: 'fake-planner-openai',
  provider: 'openai',
  modelId: 'gpt-5.6-sol',
  family: 'openai',
  harnessVersion: 'lf-0001.test-v1',
};

const graderIdentity = {
  adapterId: 'fake-grader-anthropic',
  provider: 'anthropic',
  modelId: 'claude-test',
  family: 'anthropic',
};

const environment = {
  runnerVersion: 'lf-0001.replay-runner.v1',
  baseRepoSha: 'd5961fe3974cf568b6bd080b0024eb97774ea53b',
  nodeVersion: '24.16.0',
  platform: 'darwin-arm64',
};

function buildPlan(fixtureId, trialIndex) {
  const episodeId = `${fixtureId}-trial-${trialIndex}`;
  return {
    schemaVersion: 'adaptive-sop-plan.v1',
    episodeId,
    model: {
      provider: plannerIdentity.provider,
      modelId: plannerIdentity.modelId,
      harnessVersion: plannerIdentity.harnessVersion,
    },
    taskUnderstanding: `Plan the sanitized historical task ${fixtureId} without relying on later outcomes.`,
    desiredOutcome: ['Produce a proportional, independently verifiable plan.'],
    repositoryFacts: {},
    risks: [
      {
        claim: 'The historical task may cross a protected surface.',
        evidence: [],
        uncertainty: ['Only independent admission facts can resolve the surface.'],
      },
    ],
    decisions: [
      {
        stepId: 'inspect-and-verify',
        action: 'include',
        reason: 'Ground the plan in the supplied repository context.',
        residualRisk: 'Hidden historical outcomes remain unavailable to the planner.',
      },
    ],
    executionOrder: ['inspect-and-verify'],
    outcomeChecks: ['The requested outcome is independently observable.'],
    replanTriggers: ['Independent facts reveal a protected surface.'],
    rollbackPlan: 'Return to the full SOP without executing the candidate plan.',
  };
}

function buildFacts(fixtureId, trialIndex) {
  const protectedPrivacyCase = fixtureId === 'sop-replay-privacy-spec-removal';
  return {
    schemaVersion: 'sop-admission-facts.v1',
    episodeId: `${fixtureId}-trial-${trialIndex}`,
    observedAt: '2026-07-21T03:00:00.000Z',
    repository: {
      worktreeRoot: `/tmp/replay/${fixtureId}`,
      branch: 'detached-replay',
      baseSha: environment.baseRepoSha,
      changedFiles: [],
      diffFingerprint: '0'.repeat(64),
      isolatedWorktree: true,
      recoveryWithinOneCommit: true,
    },
    data: { testDataIsolated: 'not_applicable', productionUserDataInScope: false },
    effects: {
      externalUserEffect: false,
      destructiveOrIrreversible: protectedPrivacyCase,
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
}

function buildPorts(observations = {}) {
  return {
    planner: {
      identity: plannerIdentity,
      async generatePlan(modelInput, context) {
        observations.plannerInputs?.push(modelInput);
        observations.plannerContexts?.push(context);
        return buildPlan(context.fixtureId, context.trialIndex);
      },
    },
    factsProvider: {
      async observe(input) {
        observations.factInputs?.push(input);
        return buildFacts(input.fixtureId, input.trialIndex);
      },
    },
    deterministicGrader: {
      async grade(input) {
        observations.deterministicInputs?.push(input);
        return {
          checks: [
            {
              id: 'admission-is-structured',
              status: 'pass',
              evidenceRefs: [`admission:${input.admission.status}`],
            },
          ],
          hardInvariantMisses: [],
        };
      },
    },
    modelGrader: {
      identity: graderIdentity,
      async grade(input) {
        observations.modelGraderInputs?.push(input);
        return {
          dimensions: input.rubric.dimensions.map((dimension) => ({
            id: dimension.id,
            score: 3,
            rationale: `Synthetic wiring score for ${dimension.id}.`,
            evidenceRefs: [`model-grade:${dimension.id}`],
          })),
          unnecessaryProcess: [],
          missingEvidence: [],
        };
      },
    },
  };
}

function buildRunInput(overrides = {}) {
  return {
    runId: 'adaptive-sop-wiring-001',
    createdAt: '2026-07-21T03:30:00.000Z',
    runMode: 'synthetic_wiring',
    trialsPerCandidate: 3,
    environment,
    manifest,
    rubric,
    ...buildPorts(),
    ...overrides,
  };
}

describe('LF-0001 adaptive SOP replay runner', () => {
  it('runs all fifteen candidates three times without exposing grader-only data to the planner', async () => {
    const observations = { plannerInputs: [], plannerContexts: [], modelGraderInputs: [] };
    const artifact = await runAdaptiveSopReplay({
      ...buildRunInput(),
      ...buildPorts(observations),
    });

    assert.equal(artifact.schemaVersion, 'lf-0001.replay-run.v1');
    assert.equal(artifact.summary.candidateCount, 15);
    assert.equal(artifact.summary.plannedTrials, 45);
    assert.equal(artifact.summary.completedTrials, 45);
    assert.equal(artifact.trials.length, 45);
    assert.equal(artifact.runMode, 'synthetic_wiring');
    assert.equal(artifact.eligibleForCapabilityVerdict, false);
    assert.equal(observations.plannerInputs.length, 45);
    assert.equal(observations.modelGraderInputs.length, 45);

    for (const input of observations.plannerInputs) {
      assert.equal(Object.hasOwn(input, 'graderOnly'), false);
      assert.equal(JSON.stringify(input).includes('outcomeCommit'), false);
    }
    for (const context of observations.plannerContexts) {
      assert.deepEqual(Object.keys(context).sort(), ['fixtureId', 'runId', 'trialIndex']);
    }
    assert.equal(JSON.stringify(artifact).includes('graderOnly'), false);
  });

  it('requires at least three trials per candidate', async () => {
    await assert.rejects(
      () => runAdaptiveSopReplay(buildRunInput({ trialsPerCandidate: 2 })),
      /trialsPerCandidate must be at least 3/,
    );
  });

  it('requires an independent model-grader family', async () => {
    const sameFamilyGrader = {
      ...buildPorts().modelGrader,
      identity: { ...graderIdentity, family: plannerIdentity.family },
    };
    await assert.rejects(
      () => runAdaptiveSopReplay(buildRunInput({ modelGrader: sameFamilyGrader })),
      /model grader family must differ from planner family/,
    );
  });

  it('produces byte-stable artifacts for pinned inputs and deterministic ports', async () => {
    const first = await runAdaptiveSopReplay(buildRunInput());
    const second = await runAdaptiveSopReplay(buildRunInput());
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.match(first.provenance.manifestSha256, /^[0-9a-f]{64}$/);
    assert.match(first.provenance.rubricSha256, /^[0-9a-f]{64}$/);
  });

  it('records a malformed planner trial and continues the remaining matrix', async () => {
    const oneCandidateManifest = { ...manifest, candidates: [manifest.candidates[0]] };
    const planner = {
      identity: plannerIdentity,
      async generatePlan(_modelInput, context) {
        return context.trialIndex === 1 ? {} : buildPlan(context.fixtureId, context.trialIndex);
      },
    };
    const artifact = await runAdaptiveSopReplay(
      buildRunInput({ manifest: oneCandidateManifest, planner, runMode: 'model_replay' }),
    );

    assert.equal(artifact.summary.plannedTrials, 3);
    assert.equal(artifact.summary.completedTrials, 2);
    assert.equal(artifact.summary.failedTrials, 1);
    assert.equal(artifact.trials[1].status, 'planner_contract_error');
    assert.equal(artifact.eligibleForCapabilityVerdict, false);
  });

  it('fails rubric and capability eligibility for each failed-check or missing-evidence mode', async () => {
    const oneCandidateManifest = { ...manifest, candidates: [manifest.candidates[0]] };
    const buildDeterministicGrader = ({ status = 'pass', evidenceRefs = ['review:receipt'] } = {}) => ({
      async grade() {
        return { checks: [{ id: 'review-receipt', status, evidenceRefs }], hardInvariantMisses: [] };
      },
    });
    const buildModelGrader = ({ evidenceRefs = ['model:grade'], missingEvidence = [] } = {}) => ({
      identity: graderIdentity,
      async grade(input) {
        return {
          dimensions: input.rubric.dimensions.map((dimension) => ({
            id: dimension.id,
            score: 4,
            rationale: 'A high score cannot replace missing evidence.',
            evidenceRefs,
          })),
          unnecessaryProcess: [],
          missingEvidence,
        };
      },
    });

    for (const ports of [
      { deterministicGrader: buildDeterministicGrader({ status: 'fail' }), modelGrader: buildModelGrader() },
      {
        deterministicGrader: buildDeterministicGrader({ evidenceRefs: [] }),
        modelGrader: buildModelGrader(),
      },
      {
        deterministicGrader: buildDeterministicGrader(),
        modelGrader: buildModelGrader({ evidenceRefs: [] }),
      },
      {
        deterministicGrader: buildDeterministicGrader(),
        modelGrader: buildModelGrader({ missingEvidence: ['independent review receipt'] }),
      },
    ]) {
      const artifact = await runAdaptiveSopReplay(
        buildRunInput({ manifest: oneCandidateManifest, runMode: 'model_replay', ...ports }),
      );
      assert.equal(artifact.summary.rubricPassingTrials, 0);
      assert.equal(artifact.summary.rubricFailingTrials, 3);
      assert.equal(artifact.eligibleForCapabilityVerdict, false);
    }
  });
});
