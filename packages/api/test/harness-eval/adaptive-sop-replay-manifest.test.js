import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { fingerprintAdaptiveSopComparativePilotManifest } from '../../dist/infrastructure/harness-eval/sop/adaptive-sop-comparative-pilot.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, 'fixtures');
const repositoryRoot = resolve(here, '../../../..');

function readJson(name) {
  return JSON.parse(readFileSync(join(fixtureRoot, name), 'utf8'));
}

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys);
    return keys;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      keys.push(key);
      collectKeys(entry, keys);
    }
  }
  return keys;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

describe('LF-0001 adaptive SOP replay manifest', () => {
  const manifest = readJson('adaptive-sop-replay-manifest.json');
  const rubric = readJson('adaptive-sop-grader-rubric.json');
  const comparativePilot = readJson('adaptive-sop-comparative-pilot-manifest.json');

  it('contains at least twelve unique provenance-backed candidates', () => {
    assert.equal(manifest.schemaVersion, 'lf-0001.replay-manifest.v1');
    assert.ok(manifest.candidates.length >= manifest.selectionPolicy.minimumCandidateCount);

    const ids = manifest.candidates.map((candidate) => candidate.fixtureId);
    const profileIds = new Set(rubric.profiles.map((profile) => profile.id));
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(profileIds.size, rubric.profiles.length);

    for (const candidate of manifest.candidates) {
      assert.match(candidate.fixtureId, /^sop-replay-[a-z0-9-]+$/);
      assert.ok(candidate.modelInput.taskPrompt.length >= 40);
      assert.ok(candidate.modelInput.desiredOutcomes.length > 0);
      assert.ok(candidate.modelInput.knownFacts.length > 0);
      assert.match(candidate.graderOnly.provenance.baseCommit, /^[0-9a-f]{40}$/);
      assert.match(candidate.graderOnly.provenance.outcomeCommit, /^[0-9a-f]{40}$/);
      assert.notEqual(candidate.graderOnly.provenance.baseCommit, candidate.graderOnly.provenance.outcomeCommit);
      assert.equal(
        candidate.graderOnly.provenance.commitUrl,
        `https://github.com/zts212653/clowder-ai/commit/${candidate.graderOnly.provenance.outcomeCommit}`,
      );
      assert.ok(candidate.graderOnly.outcomeEvidence.changedPaths.length > 0);
      assert.ok(candidate.graderOnly.graderProfileIds.length > 0);
      for (const profileId of candidate.graderOnly.graderProfileIds) {
        assert.ok(profileIds.has(profileId), `${candidate.fixtureId} references unknown profile ${profileId}`);
      }
    }
  });

  it('resolves every provenance commit and proves complete scopes against the Git diff', () => {
    for (const candidate of manifest.candidates) {
      const { baseCommit, outcomeCommit } = candidate.graderOnly.provenance;
      for (const commit of [baseCommit, outcomeCommit]) {
        assert.equal(
          spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: repositoryRoot }).status,
          0,
          `${candidate.fixtureId} references missing commit ${commit}`,
        );
      }
      assert.equal(
        spawnSync('git', ['merge-base', '--is-ancestor', baseCommit, outcomeCommit], {
          cwd: repositoryRoot,
        }).status,
        0,
        `${candidate.fixtureId} base is not an ancestor of outcome`,
      );

      if (candidate.graderOnly.outcomeEvidence.scope !== 'complete') continue;
      const actualPaths = execFileSync('git', ['diff', '--name-only', `${baseCommit}..${outcomeCommit}`], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      })
        .trim()
        .split('\n')
        .filter(Boolean)
        .sort();
      assert.deepEqual(
        actualPaths,
        [...candidate.graderOnly.outcomeEvidence.changedPaths].sort(),
        `${candidate.fixtureId} complete scope must equal its Git diff`,
      );
    }
  });

  it('checks out full history in Public Test before validating Git provenance', () => {
    const workflow = parseYaml(readFileSync(join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8'));
    const checkout = workflow.jobs.test.steps.find((step) => step.uses === 'actions/checkout@v4');
    assert.ok(checkout, 'Public Test must include actions/checkout');
    assert.equal(checkout.with?.['fetch-depth'], 0, 'Public Test provenance validation requires full Git history');
  });

  it('projects only modelInput and keeps answer-bearing fields grader-only', () => {
    assert.equal(manifest.modelProjection.candidatePath, 'candidates[].modelInput');
    assert.deepEqual(manifest.modelProjection.excludedSiblingFields, ['graderOnly']);

    const forbidden =
      /expected(answer|outcome|steps?)|actualoutcome|observedoutcome|verdict|solution|grader|(^|_)commit|pullrequest|prnumber/i;
    for (const candidate of manifest.candidates) {
      const leakedKeys = collectKeys(candidate.modelInput).filter((key) => forbidden.test(key));
      assert.deepEqual(leakedKeys, [], `${candidate.fixtureId} leaks answer-bearing keys`);
      assert.doesNotMatch(
        JSON.stringify(candidate.modelInput),
        /\b[0-9a-f]{40}\b/,
        `${candidate.fixtureId} leaks a Git object id`,
      );
    }
  });

  it('contains proportionality probes without prescribing one canonical procedure', () => {
    const omissionProbes = manifest.candidates.filter(
      (candidate) => candidate.graderOnly.strategyFlexibility.safeOmissions.length > 0,
    );
    assert.ok(omissionProbes.length >= 3);
    assert.equal(rubric.canonicalToolSequence, null);
    assert.match(rubric.strategyPolicy, /outcome|invariant/i);
  });

  it('keeps sensitive-history replay sanitized and non-materializing', () => {
    const privacyFixture = manifest.candidates.find(
      (candidate) => candidate.fixtureId === 'sop-replay-privacy-spec-removal',
    );
    assert.ok(privacyFixture);
    assert.equal(privacyFixture.modelInput.repositorySnapshot.mode, 'sanitized_context_only');
    assert.deepEqual(privacyFixture.modelInput.repositorySnapshot.visiblePaths, []);
    assert.equal(privacyFixture.graderOnly.provenance.materializeBaseCommit, false);
    assert.doesNotMatch(JSON.stringify(privacyFixture.modelInput), /account|balance|income|asset/i);
  });

  it('includes a provenance-backed contained code-changing pilot candidate', () => {
    const candidate = manifest.candidates.find((entry) => entry.fixtureId === 'sop-replay-stale-formatter-regression');
    assert.ok(candidate);
    assert.equal(candidate.graderOnly.provenance.sourcePullRequest, 655);
    assert.equal(candidate.graderOnly.provenance.baseCommit, '8335b91253f690324f29739ef12ad8575fdb897b');
    assert.deepEqual(candidate.graderOnly.outcomeEvidence.changedPaths, [
      'packages/api/test/telegram-html-formatter.test.js',
    ]);
    assert.deepEqual(candidate.graderOnly.outcomeEvidence.testPaths, [
      'packages/api/test/telegram-html-formatter.test.js',
    ]);
    assert.ok(candidate.graderOnly.challengeTags.includes('code-changing'));
    assert.ok(candidate.graderOnly.challengeTags.includes('test-only'));
    assert.match(candidate.modelInput.taskPrompt, /formatter regression/i);
    assert.ok(candidate.modelInput.constraints.includes('Do not modify formatter or adapter runtime code.'));
  });

  it('pins the three-arm pilot without projecting trusted outcomes to executors', () => {
    const candidate = manifest.candidates.find((entry) => entry.fixtureId === comparativePilot.fixtureId);
    assert.ok(candidate);
    assert.equal(comparativePilot.schemaVersion, 'lf-0001.comparative-pilot-manifest.v1');
    assert.match(fingerprintAdaptiveSopComparativePilotManifest(comparativePilot), /^[0-9a-f]{64}$/);
    assert.equal(comparativePilot.sourcePullRequest, candidate.graderOnly.provenance.sourcePullRequest);
    assert.equal(comparativePilot.baseCommit, candidate.graderOnly.provenance.baseCommit);
    assert.equal(
      comparativePilot.modelInputSha256,
      createHash('sha256').update(canonicalJson(candidate.modelInput)).digest('hex'),
    );
    assert.equal(comparativePilot.trialsPerArm, 3);
    assert.ok(comparativePilot.arms.every((arm) => arm.harnessVersion.length > 0));
    assert.deepEqual(
      comparativePilot.arms.map((arm) => arm.id),
      ['full_sop', 'free_plan_hard_gates', 'adaptive_plan_hard_gates'],
    );
    assert.equal(comparativePilot.controls.trustedOutcomeHiddenFromExecutors, true);
    assert.equal(comparativePilot.controls.sameHardGates, true);
    assert.deepEqual(
      comparativePilot.comparability.allowedChangedPaths,
      candidate.graderOnly.outcomeEvidence.changedPaths,
    );
    assert.equal(comparativePilot.comparability.outcomeOracle.successExitCode, 0);
    assert.equal(comparativePilot.comparability.gatePolicy.successExitCode, 0);
    assert.ok(comparativePilot.comparability.toolPermissionsPolicy.description.length > 0);
    assert.ok(comparativePilot.comparability.dataIsolationPolicy.description.length > 0);
    assert.ok(comparativePilot.comparability.reviewBoundaryPolicy.description.length > 0);
    assert.equal(JSON.stringify(comparativePilot).includes(candidate.graderOnly.provenance.outcomeCommit), false);
  });

  it('defines a weighted rubric with hard invariant vetoes and leakage controls', () => {
    assert.equal(rubric.schemaVersion, 'lf-0001.grader-rubric.v1');
    assert.equal(
      rubric.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0),
      100,
    );
    const requiredCheckIds = new Set(rubric.requiredDeterministicChecks.map((check) => check.id));
    for (const id of [
      'expected-admission',
      'independent-facts-profile',
      'provenance-identity',
      'sensitive-history-projection',
    ]) {
      assert.equal(requiredCheckIds.has(id), true);
    }
    for (const veto of rubric.hardInvariantVetoes) assert.equal(requiredCheckIds.has(veto.id), true);
    assert.equal(
      rubric.hardInvariantVetoes.every((veto) => veto.applicability === 'always'),
      true,
    );
    assert.ok(rubric.hardInvariantVetoes.length >= 6);
    assert.equal(rubric.gradingProtocol.hardInvariantMiss, 'fail');
    assert.equal(rubric.leakageControls.modelReceives, 'candidate.modelInput only');
    assert.equal(rubric.leakageControls.outcomeCommitVisibleToPlanner, false);
    assert.equal(rubric.leakageControls.graderOnlyVisibleToPlanner, false);
    assert.equal(rubric.leakageControls.rubricVisibleToPlanner, false);
  });
});
