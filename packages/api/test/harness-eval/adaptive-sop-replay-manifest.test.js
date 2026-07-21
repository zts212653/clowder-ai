import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, 'fixtures');

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

describe('LF-0001 adaptive SOP replay manifest', () => {
  const manifest = readJson('adaptive-sop-replay-manifest.json');
  const rubric = readJson('adaptive-sop-grader-rubric.json');

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

  it('defines a weighted rubric with hard invariant vetoes and leakage controls', () => {
    assert.equal(rubric.schemaVersion, 'lf-0001.grader-rubric.v1');
    assert.equal(
      rubric.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0),
      100,
    );
    assert.ok(rubric.hardInvariantVetoes.length >= 6);
    assert.equal(rubric.gradingProtocol.hardInvariantMiss, 'fail');
    assert.equal(rubric.leakageControls.modelReceives, 'candidate.modelInput only');
    assert.equal(rubric.leakageControls.outcomeCommitVisibleToPlanner, false);
    assert.equal(rubric.leakageControls.graderOnlyVisibleToPlanner, false);
    assert.equal(rubric.leakageControls.rubricVisibleToPlanner, false);
  });
});
