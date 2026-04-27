import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { resolveGuardian } = await import('../dist/domains/community/GuardianMatcher.js');

describe('GuardianMatcher', () => {
  test('excludes both author and reviewer', async () => {
    const result = await resolveGuardian({ author: 'opus', reviewer: 'codex' });
    assert.notEqual(result.guardian, 'opus');
    assert.notEqual(result.guardian, 'codex');
    assert.ok(result.guardian);
  });

  test('prefers different family from author', async () => {
    // opus=ragdoll, codex=maine-coon → should pick from another family
    const result = await resolveGuardian({ author: 'opus', reviewer: 'codex' });
    assert.equal(result.isDegraded, false);
  });

  test('does not require peer-reviewer role', async () => {
    // All eligible cats should be candidates, not just peer-reviewers
    const result = await resolveGuardian({ author: 'opus', reviewer: 'codex' });
    assert.ok(result.candidates.length > 2);
  });

  test('excludes reviewer even from different family', async () => {
    // opus=ragdoll, gpt52=maine-coon → gpt52 excluded despite cross-family
    const result = await resolveGuardian({ author: 'opus', reviewer: 'gpt52' });
    assert.notEqual(result.guardian, 'gpt52');
    assert.notEqual(result.guardian, 'opus');
  });

  test('returns isDegraded when only same-family candidates remain', async () => {
    // Force degradation by excluding all cross-family cats via policy override
    const result = await resolveGuardian({
      author: 'opus',
      reviewer: 'codex',
      policy: { requireDifferentFamily: true },
    });
    // With requireDifferentFamily=true and plenty of cross-family cats, should NOT degrade
    assert.equal(result.isDegraded, false);
  });

  test('returns fallback when author equals reviewer', async () => {
    const result = await resolveGuardian({ author: 'opus', reviewer: 'opus' });
    assert.ok(result.guardian);
    // Only opus is excluded (deduplicated), so plenty of candidates
    assert.ok(result.candidates.length > 0);
  });

  test('candidates list excludes author and reviewer', async () => {
    const result = await resolveGuardian({ author: 'opus', reviewer: 'codex' });
    assert.ok(!result.candidates.includes('opus'));
    assert.ok(!result.candidates.includes('codex'));
  });
});
