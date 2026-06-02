import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

const { resolveGuardian } = await import('../dist/domains/community/GuardianMatcher.js');
const { _resetCachedConfig, getRoster, loadCatConfig } = await import('../dist/config/cat-config-loader.js');

// F211 flake fix: load the canonical roster directly from the repo template.
// An explicit path skips the .cat-cafe/cat-catalog.json overlay, so these
// guardian-matching unit tests stay hermetic to the ambient breeds:[] catalog
// artifacts that other concurrent test files create (the candidates=0 flake).
const REPO_TEMPLATE = resolve(import.meta.dirname, '../../../cat-template.json');
const FULL_ROSTER = loadCatConfig(REPO_TEMPLATE).roster;

describe('GuardianMatcher', () => {
  test('excludes both author and reviewer', async () => {
    const result = await resolveGuardian({ author: 'opus', reviewer: 'codex', roster: FULL_ROSTER });
    assert.notEqual(result.guardian, 'opus');
    assert.notEqual(result.guardian, 'codex');
    assert.ok(result.guardian);
  });

  test('prefers different family from author', async () => {
    // opus=ragdoll, codex=maine-coon → should pick from another family
    const result = await resolveGuardian({ author: 'opus', reviewer: 'codex', roster: FULL_ROSTER });
    assert.equal(result.isDegraded, false);
  });

  test('does not require peer-reviewer role', async () => {
    // All eligible cats should be candidates, not just peer-reviewers
    const result = await resolveGuardian({ author: 'opus', reviewer: 'codex', roster: FULL_ROSTER });
    assert.ok(result.candidates.length > 2);
  });

  test('excludes reviewer even from different family', async () => {
    // opus=ragdoll, gpt52=maine-coon → gpt52 excluded despite cross-family
    const result = await resolveGuardian({ author: 'opus', reviewer: 'gpt52', roster: FULL_ROSTER });
    assert.notEqual(result.guardian, 'gpt52');
    assert.notEqual(result.guardian, 'opus');
  });

  test('returns isDegraded when only same-family candidates remain', async () => {
    // Force degradation by excluding all cross-family cats via policy override
    const result = await resolveGuardian({
      author: 'opus',
      reviewer: 'codex',
      roster: FULL_ROSTER,
      policy: { requireDifferentFamily: true },
    });
    // With requireDifferentFamily=true and plenty of cross-family cats, should NOT degrade
    assert.equal(result.isDegraded, false);
  });

  test('returns fallback when author equals reviewer', async () => {
    const result = await resolveGuardian({ author: 'opus', reviewer: 'opus', roster: FULL_ROSTER });
    assert.ok(result.guardian);
    // Only opus is excluded (deduplicated), so plenty of candidates
    assert.ok(result.candidates.length > 0);
  });

  test('candidates list excludes author and reviewer', async () => {
    const result = await resolveGuardian({ author: 'opus', reviewer: 'codex', roster: FULL_ROSTER });
    assert.ok(!result.candidates.includes('opus'));
    assert.ok(!result.candidates.includes('codex'));
  });

  // F211 flake regression: under the concurrent api test suite, another file can leave a
  // bootstrap/empty (breeds:[]) cat-catalog.json at the active CAT_TEMPLATE_PATH dir. The
  // #772 merge then prunes every breed's roster entry, collapsing the roster to {owner} →
  // roster['opus'] is undefined → resolveGuardian returned candidates:[] → "candidates.length
  // > 0" flaked. Injecting the roster makes resolution hermetic to that ambient artifact.
  test('injected roster is hermetic to a breeds:[] ambient catalog (flake regression)', async () => {
    // Build a self-contained polluted config root (unique temp dir, never a shared path)
    // and point CAT_TEMPLATE_PATH at it, so this test cannot perturb concurrent test files.
    const savedTemplate = process.env.CAT_TEMPLATE_PATH;
    const isoRoot = mkdtempSync(resolve(tmpdir(), 'guardian-flake-'));
    const tpl = JSON.parse(readFileSync(REPO_TEMPLATE, 'utf-8'));
    try {
      writeFileSync(resolve(isoRoot, 'cat-template.json'), JSON.stringify(tpl));
      mkdirSync(resolve(isoRoot, '.cat-cafe'), { recursive: true });
      // Reproduce the concurrent-suite pollution: a bootstrap/empty (breeds:[]) catalog overlay.
      writeFileSync(
        resolve(isoRoot, '.cat-cafe', 'cat-catalog.json'),
        JSON.stringify({
          ...tpl,
          breeds: [],
          roster: { owner: { family: 'owner', roles: ['owner'], lead: false, available: true, evaluation: 'x' } },
        }),
      );
      process.env.CAT_TEMPLATE_PATH = resolve(isoRoot, 'cat-template.json');
      _resetCachedConfig();
      // Precondition: the polluted ambient really does collapse the roster (the flake trigger).
      assert.ok(
        Object.keys(getRoster()).length <= 1,
        'breeds:[] catalog should collapse the ambient roster to owner-only',
      );
      // Fix: an injected roster ignores the ambient config entirely → candidates survive.
      const result = await resolveGuardian({ author: 'opus', reviewer: 'opus', roster: FULL_ROSTER });
      assert.ok(result.candidates.length > 0, 'injected roster yields candidates despite breeds:[] ambient');
    } finally {
      if (savedTemplate === undefined) delete process.env.CAT_TEMPLATE_PATH;
      else process.env.CAT_TEMPLATE_PATH = savedTemplate;
      rmSync(isoRoot, { recursive: true, force: true });
      _resetCachedConfig();
    }
  });
});
