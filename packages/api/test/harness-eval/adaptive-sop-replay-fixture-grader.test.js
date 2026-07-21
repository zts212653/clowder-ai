import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateSopAdmission } from '../../dist/infrastructure/harness-eval/sop/adaptive-sop-admission.js';
import {
  createManifestDeterministicGrader,
  createManifestFactsProvider,
} from '../../dist/infrastructure/harness-eval/sop/adaptive-sop-replay-fixture-grader.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(here, 'fixtures');
const manifest = readJson('adaptive-sop-replay-manifest.json');
const rubric = readJson('adaptive-sop-grader-rubric.json');
const profileBank = readJson('adaptive-sop-admission-profiles.json');

function readJson(filename) {
  return JSON.parse(readFileSync(join(fixturesRoot, filename), 'utf8'));
}

function buildPlan(fixtureId, trialIndex = 0) {
  return {
    schemaVersion: 'adaptive-sop-plan.v1',
    episodeId: `${fixtureId}-trial-${trialIndex}`,
    model: { provider: 'openai', modelId: 'planner-test', harnessVersion: 'lf-0001.test-v1' },
    taskUnderstanding: `Plan ${fixtureId} from the sanitized pre-outcome context.`,
    desiredOutcome: ['Produce a proportional and independently verifiable plan.'],
    repositoryFacts: {},
    risks: [
      {
        claim: 'Independent facts may reveal a protected surface.',
        evidence: [],
        uncertainty: ['The planner cannot determine admission from the prompt alone.'],
      },
    ],
    decisions: [
      {
        stepId: 'inspect-and-verify',
        action: 'include',
        reason: 'Ground work in the supplied repository context.',
        residualRisk: 'Later outcome evidence remains hidden.',
      },
    ],
    executionOrder: ['inspect-and-verify'],
    outcomeChecks: ['The requested outcome is independently observable.'],
    replanTriggers: ['Independent facts reveal a protected surface.'],
    rollbackPlan: 'Return to the full SOP before executing a protected plan.',
  };
}

function buildPorts() {
  return {
    factsProvider: createManifestFactsProvider({
      profileBank,
      observedAt: '2026-07-21T04:00:00.000Z',
      worktreeRootPrefix: '/isolated/replay',
    }),
    deterministicGrader: createManifestDeterministicGrader({ profileBank }),
  };
}

describe('LF-0001 provenance-backed replay facts and deterministic grader', () => {
  it('covers every manifest candidate with independent facts and the expected admission', async () => {
    const { factsProvider, deterministicGrader } = buildPorts();
    const counts = { admitted: 0, revise: 0, blocked: 0 };

    for (const candidate of manifest.candidates) {
      const plan = buildPlan(candidate.fixtureId);
      const facts = await factsProvider.observe({
        runId: 'fixture-grade-test',
        fixtureId: candidate.fixtureId,
        trialIndex: 0,
        plan,
        trustedCandidate: candidate,
        environment: {},
      });
      const admission = evaluateSopAdmission(plan, facts);
      const grade = await deterministicGrader.grade({
        runId: 'fixture-grade-test',
        fixtureId: candidate.fixtureId,
        trialIndex: 0,
        trustedCandidate: candidate,
        rubric,
        plan,
        facts,
        admission,
        environment: {},
      });

      counts[admission.status] += 1;
      assert.equal(facts.repository.baseSha, candidate.graderOnly.provenance.baseCommit);
      assert.deepEqual(facts.repository.changedFiles, []);
      assert.equal(JSON.stringify(facts).includes(candidate.graderOnly.outcomeEvidence.changedPaths[0]), false);
      assert.deepEqual(grade.hardInvariantMisses, []);
      assert.equal(
        grade.checks.every((check) => check.status !== 'fail'),
        true,
      );
    }

    assert.deepEqual(counts, { admitted: 1, revise: 0, blocked: 13 });
  });

  it('produces stable facts for a pinned profile bank and observation time', async () => {
    const { factsProvider } = buildPorts();
    const candidate = manifest.candidates[0];
    const plan = buildPlan(candidate.fixtureId);
    const input = {
      runId: 'stable-facts-test',
      fixtureId: candidate.fixtureId,
      trialIndex: 0,
      plan,
      trustedCandidate: candidate,
      environment: {},
    };

    assert.deepEqual(await factsProvider.observe(input), await factsProvider.observe(input));
  });

  it('reports a hard-invariant miss when protected replay facts are treated as admitted', async () => {
    const { factsProvider, deterministicGrader } = buildPorts();
    const candidate = manifest.candidates.find(
      (item) => item.fixtureId === 'sop-replay-invocation-interrupt-self-heal',
    );
    const plan = buildPlan(candidate.fixtureId);
    const facts = await factsProvider.observe({
      runId: 'tampered-admission-test',
      fixtureId: candidate.fixtureId,
      trialIndex: 0,
      plan,
      trustedCandidate: candidate,
      environment: {},
    });
    const grade = await deterministicGrader.grade({
      runId: 'tampered-admission-test',
      fixtureId: candidate.fixtureId,
      trialIndex: 0,
      trustedCandidate: candidate,
      rubric,
      plan,
      facts,
      admission: {
        schemaVersion: 'sop-admission-decision.v1',
        status: 'admitted',
        episodeId: plan.episodeId,
        envelopeFingerprint: '0'.repeat(64),
      },
      environment: {},
    });

    assert.deepEqual(grade.hardInvariantMisses, ['runtime_or_startup_reconfiguration']);
  });

  it('fails the privacy invariant if sanitized history is marked materializable', async () => {
    const { factsProvider, deterministicGrader } = buildPorts();
    const original = manifest.candidates.find((item) => item.fixtureId === 'sop-replay-privacy-spec-removal');
    const candidate = {
      ...original,
      graderOnly: {
        ...original.graderOnly,
        provenance: { ...original.graderOnly.provenance, materializeBaseCommit: true },
      },
    };
    const plan = buildPlan(candidate.fixtureId);
    const facts = await factsProvider.observe({
      runId: 'privacy-invariant-test',
      fixtureId: candidate.fixtureId,
      trialIndex: 0,
      plan,
      trustedCandidate: candidate,
      environment: {},
    });
    const admission = evaluateSopAdmission(plan, facts);
    const grade = await deterministicGrader.grade({
      runId: 'privacy-invariant-test',
      fixtureId: candidate.fixtureId,
      trialIndex: 0,
      trustedCandidate: candidate,
      rubric,
      plan,
      facts,
      admission,
      environment: {},
    });

    assert.equal(grade.checks.find((check) => check.id === 'sensitive-history-projection').status, 'fail');
    assert.deepEqual(grade.hardInvariantMisses, ['sensitive_history_exposure']);
  });

  it('fails closed when a candidate has no admission-profile assignment', async () => {
    const { factsProvider } = buildPorts();
    const candidate = { ...manifest.candidates[0], fixtureId: 'unassigned-fixture' };
    const plan = buildPlan(candidate.fixtureId);

    await assert.rejects(
      () =>
        factsProvider.observe({
          runId: 'missing-profile-test',
          fixtureId: candidate.fixtureId,
          trialIndex: 0,
          plan,
          trustedCandidate: candidate,
          environment: {},
        }),
      /no admission profile assignment for unassigned-fixture/,
    );
  });
});
