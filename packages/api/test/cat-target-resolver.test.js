/**
 * Tests for resolveCatTarget (F182 Phase A)
 * KD-9: two-step roster check — not-in-roster → cat_not_found, in-roster-disabled → cat_disabled
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import './helpers/setup-cat-registry.js';

describe('resolveCatTarget', () => {
  it('returns ok for known available cat by catId', async () => {
    const { resolveCatTarget } = await import('../dist/domains/cats/services/agents/routing/cat-target-resolver.js');
    const result = resolveCatTarget('opus');
    assert.ok('ok' in result, 'should return ok for available cat');
    assert.equal(result.ok, 'opus');
  });

  it('returns ok for known cat by @mention pattern', async () => {
    const { resolveCatTarget } = await import('../dist/domains/cats/services/agents/routing/cat-target-resolver.js');
    const result = resolveCatTarget('@codex');
    assert.ok('ok' in result, 'should resolve @codex mention to ok');
    assert.equal(result.ok, 'codex');
  });

  it('returns ok for cat by Chinese mention pattern', async () => {
    const { resolveCatTarget } = await import('../dist/domains/cats/services/agents/routing/cat-target-resolver.js');
    const result = resolveCatTarget('@缅因猫');
    assert.ok('ok' in result, 'should resolve Chinese mention to ok');
    assert.equal(result.ok, 'codex');
  });

  it('returns cat_not_found for unknown mention', async () => {
    const { resolveCatTarget } = await import('../dist/domains/cats/services/agents/routing/cat-target-resolver.js');
    const result = resolveCatTarget('@xyzunknowncat9999');
    assert.ok('error' in result, 'should return error for unknown mention');
    assert.equal(result.error.kind, 'cat_not_found');
    assert.equal(result.error.mention, '@xyzunknowncat9999');
  });

  it('returns cat_not_found for unknown catId', async () => {
    const { resolveCatTarget } = await import('../dist/domains/cats/services/agents/routing/cat-target-resolver.js');
    const result = resolveCatTarget('xyzunknown9999');
    assert.ok('error' in result, 'should return error for unknown catId');
    assert.equal(result.error.kind, 'cat_not_found');
  });

  it('KD-9: disabled cat (in roster, available:false) → cat_disabled not cat_not_found', async () => {
    const { resolveCatTarget } = await import('../dist/domains/cats/services/agents/routing/cat-target-resolver.js');
    // antigravity is in roster with available:false in cat-template.json
    const result = resolveCatTarget('antigravity');
    assert.ok('error' in result, 'should return error for disabled cat');
    assert.equal(result.error.kind, 'cat_disabled', 'must be cat_disabled, not cat_not_found');
    assert.equal(result.error.catId, 'antigravity');
    assert.ok(typeof result.error.displayName === 'string' && result.error.displayName.length > 0);
  });

  it('alternatives exclude the disabled cat', async () => {
    const { resolveCatTarget } = await import('../dist/domains/cats/services/agents/routing/cat-target-resolver.js');
    const result = resolveCatTarget('antigravity');
    assert.ok('error' in result && result.error.kind === 'cat_disabled');
    assert.ok(
      !result.error.alternatives.some((a) => a.catId === 'antigravity'),
      'disabled cat must not appear in its own alternatives',
    );
  });

  it('alternatives exclude other disabled cats', async () => {
    const { resolveCatTarget } = await import('../dist/domains/cats/services/agents/routing/cat-target-resolver.js');
    const result = resolveCatTarget('antigravity');
    assert.ok('error' in result && result.error.kind === 'cat_disabled');
    for (const alt of result.error.alternatives) {
      assert.ok(alt.catId, 'each alternative must have catId');
      assert.ok(alt.mention, 'each alternative must have mention');
      assert.ok(alt.displayName, 'each alternative must have displayName');
      assert.ok(alt.family, 'each alternative must have family');
    }
  });

  it('alternatives have no duplicate catIds (dedupe)', async () => {
    const { resolveCatTarget } = await import('../dist/domains/cats/services/agents/routing/cat-target-resolver.js');
    const result = resolveCatTarget('antigravity');
    assert.ok('error' in result && result.error.kind === 'cat_disabled');
    const ids = result.error.alternatives.map((a) => a.catId);
    assert.equal(new Set(ids).size, ids.length, 'alternatives must have unique catIds');
  });

  it('alternatives: same family sorted before other families', async () => {
    const { resolveCatTarget } = await import('../dist/domains/cats/services/agents/routing/cat-target-resolver.js');
    // antigravity is bengal family; antig-opus is also bengal
    const result = resolveCatTarget('antigravity');
    assert.ok('error' in result && result.error.kind === 'cat_disabled');
    const alts = result.error.alternatives;
    const bengalAlts = alts.filter((a) => a.family === 'bengal');
    const nonBengalAlts = alts.filter((a) => a.family !== 'bengal');
    if (bengalAlts.length > 0 && nonBengalAlts.length > 0) {
      const lastBengalIdx = alts.findLastIndex((a) => a.family === 'bengal');
      const firstNonBengalIdx = alts.findIndex((a) => a.family !== 'bengal');
      assert.ok(lastBengalIdx < firstNonBengalIdx, 'same-family alts must precede other families');
    }
  });
});
