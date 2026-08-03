import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runF287MemoryCueReplay } from '../../dist/scripts/f287-memory-cue-replay.js';

const EXPECTED_FAMILIES = ['person_entity', 'operational_precedent', 'taste'];
const EXPECTED_BUDGET_CANDIDATE_TOKENS = {
  person_entity: 736,
  operational_precedent: 737,
  taste: 745,
};

function containsForbiddenScore(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenScore);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, child]) => key === 'totalScore' || key === 'globalScore' || containsForbiddenScore(child),
  );
}

describe('F287 memory cue utility replay', () => {
  it('is byte-repeatable and emits one raw constraint vector and verdict per cue family', async () => {
    const first = await runF287MemoryCueReplay();
    const second = await runF287MemoryCueReplay();

    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(first.fixtureRevision, 'f287-memory-cue-eval-v1');
    assert.equal(first.catalogVersion, 1);
    assert.deepEqual(
      first.families.map(({ family }) => family),
      EXPECTED_FAMILIES,
    );
    assert.deepEqual(
      first.families.map(({ verdict }) => verdict),
      ['keep', 'keep', 'keep'],
    );
    assert.equal(containsForbiddenScore(first), false);

    for (const result of first.families) {
      assert.deepEqual(result.vector.relevant, { opportunities: 1, presented: 1 });
      assert.deepEqual(result.vector.irrelevant, { opportunities: 1, presented: 0 });
      assert.deepEqual(result.vector.duplicate, { replays: 1, additionalPresented: 0 });
      assert.equal(result.vector.budget.opportunities, 1);
      assert.equal(result.vector.budget.presented, 0);
      assert.ok(result.vector.budget.maxPromptTokens > 0);
      assert.equal(result.vector.budget.candidateEstimatedTokens, EXPECTED_BUDGET_CANDIDATE_TOKENS[result.family]);
      assert.ok(result.vector.budget.candidateEstimatedTokens > result.vector.budget.maxPromptTokens);
      assert.deepEqual(result.vector.sourceCorrected, {
        opportunities: 1,
        presented: 1,
        drillStatus: 'not_available',
        invalidationReason: 'source_corrected',
      });
      assert.deepEqual(result.vector.sourceForgotten, {
        opportunities: 1,
        presented: 1,
        drillStatus: 'not_available',
        invalidationReason: 'source_forgotten',
      });
      assert.deepEqual(result.vector.privateUnavailable, {
        opportunities: 1,
        presented: 1,
        drillStatus: 'not_available',
        denialReason: 'scope_mismatch',
      });
      assert.deepEqual(result.vector.crossOwner, { opportunities: 1, presented: 0 });
      assert.deepEqual(result.vector.unknownEvent, { opportunities: 1, presented: 0 });
      assert.deepEqual(result.hardConstraintFailures, []);
    }
  });
});
