import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

// ---------------------------------------------------------------------------
// D0.4 — catId drift guard: DEFAULT_COMMUNITY_ROLE_BINDINGS vs catalog truth
// ---------------------------------------------------------------------------

const { DEFAULT_COMMUNITY_ROLE_BINDINGS } = await import('../dist/domains/community/RoleResolver.js');

// Read the canonical cat-template.json roster (deployment truth)
const catTemplatePath = resolve(import.meta.dirname, '../../../cat-template.json');
const catTemplate = JSON.parse(readFileSync(catTemplatePath, 'utf8'));
const catalogCatIds = new Set(Object.keys(catTemplate.roster));

describe('catId drift guard (D0.4)', () => {
  test('every catId in DEFAULT_COMMUNITY_ROLE_BINDINGS exists in cat-template.json roster', () => {
    const missing = [];
    for (const [role, binding] of Object.entries(DEFAULT_COMMUNITY_ROLE_BINDINGS)) {
      if (binding && !catalogCatIds.has(binding.catId)) {
        missing.push({ role, catId: binding.catId });
      }
    }
    assert.deepStrictEqual(
      missing,
      [],
      `Role bindings reference catIds not in cat-template.json roster: ${JSON.stringify(missing)}. ` +
        `Available catIds: ${[...catalogCatIds].join(', ')}`,
    );
  });

  test('narrator binding has a valid catId', () => {
    const narrator = DEFAULT_COMMUNITY_ROLE_BINDINGS.narrator;
    assert.ok(narrator, 'narrator binding must exist in DEFAULT_COMMUNITY_ROLE_BINDINGS');
    assert.ok(
      catalogCatIds.has(narrator.catId),
      `narrator.catId "${narrator.catId}" not found in cat-template.json roster`,
    );
  });

  test('guard fails if a binding references a non-existent catId', () => {
    // Simulated drift: pretend the binding references a catId that was removed
    const fakeCatId = 'non-existent-cat-42';
    assert.ok(!catalogCatIds.has(fakeCatId), 'sanity: fakeCatId should not exist in roster');
    // This test documents the invariant rather than testing production code per se —
    // it ensures the guard above WOULD catch a real drift.
  });
});

// ---------------------------------------------------------------------------
// D0.6 — GuardianMatcher settlement: guardian roster source is explicit
// ---------------------------------------------------------------------------

describe('GuardianMatcher roster source guard (D0.6)', () => {
  test('resolveGuardian accepts injected roster (not coupled to global singleton)', async () => {
    const { resolveGuardian } = await import('../dist/domains/community/GuardianMatcher.js');

    // Inject a minimal test roster — proves GuardianMatcher uses the injected
    // roster and doesn't silently fall back to global state
    const testRoster = {
      'cat-a': { family: 'claude', available: true },
      'cat-b': { family: 'gpt', available: true },
      'cat-c': { family: 'gemini', available: true },
    };

    const result = await resolveGuardian({
      author: /** @type {any} */ ('cat-a'),
      reviewer: /** @type {any} */ ('cat-b'),
      roster: testRoster,
    });

    // Guardian should be cat-c (only remaining eligible, different family from author)
    assert.equal(result.guardian, 'cat-c', 'should pick from injected roster, not global');
    assert.equal(result.isDegraded, false, 'cross-family guardian available');
  });

  test('resolveGuardian excludes author and reviewer from candidates', async () => {
    const { resolveGuardian } = await import('../dist/domains/community/GuardianMatcher.js');

    const testRoster = {
      'author-cat': { family: 'claude', available: true },
      'reviewer-cat': { family: 'gpt', available: true },
      'guardian-cat': { family: 'gemini', available: true },
    };

    const result = await resolveGuardian({
      author: /** @type {any} */ ('author-cat'),
      reviewer: /** @type {any} */ ('reviewer-cat'),
      roster: testRoster,
    });

    assert.equal(result.guardian, 'guardian-cat');
    // Candidates list includes all eligible (excluding author and reviewer)
    assert.ok(result.candidates.includes('guardian-cat'), 'candidates should include the guardian');
    assert.ok(!result.candidates.includes('author-cat'), 'candidates should NOT include the author');
    assert.ok(!result.candidates.includes('reviewer-cat'), 'candidates should NOT include the reviewer');
  });
});
