import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { catRegistry } from '../dist/registry/CatRegistry.js';
import { normalizeCatId } from '../dist/registry/normalize-cat-id.js';
import { CAT_CONFIGS } from '../dist/types/cat.js';
import { createCatId } from '../dist/types/ids.js';

/** Build a CatConfig from CAT_CONFIGS defaults + overrides */
function makeCatConfig(base, overrides = {}) {
  return { ...CAT_CONFIGS[base], ...overrides };
}

describe('normalizeCatId (F154 AC-A3, AC-A7)', () => {
  before(() => {
    catRegistry.reset();
    catRegistry.register('opus', makeCatConfig('opus'));
    catRegistry.register(
      'opus-45',
      makeCatConfig('opus', {
        id: createCatId('opus-45'),
        name: '布偶猫 Opus 4.5',
        displayName: '布偶猫 Opus 4.5',
        nickname: undefined,
        mentionPatterns: ['@opus-45'],
      }),
    );
    catRegistry.register('codex', makeCatConfig('codex'));
  });
  after(() => catRegistry.reset());

  // --- Exact catId match ---
  it('exact catId → ok', () => {
    const r = normalizeCatId('opus');
    assert.equal(r.ok, true);
    assert.equal(r.catId, 'opus');
  });

  // --- Exact alias match (strip @) ---
  it('alias with @ prefix → ok', () => {
    const r = normalizeCatId('@宪宪');
    assert.equal(r.ok, true);
    assert.equal(r.catId, 'opus');
  });

  it('alias without @ → ok', () => {
    const r = normalizeCatId('宪宪');
    assert.equal(r.ok, true);
    assert.equal(r.catId, 'opus');
  });

  // --- Case insensitive ---
  it('case insensitive alias → ok', () => {
    const r = normalizeCatId('Opus');
    assert.equal(r.ok, true);
    assert.equal(r.catId, 'opus');
  });

  it('case insensitive @ alias → ok', () => {
    const r = normalizeCatId('@Codex');
    assert.equal(r.ok, true);
    assert.equal(r.catId, 'codex');
  });

  // --- Not found ---
  it('unknown name → not-found', () => {
    const r = normalizeCatId('unknown');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-found');
  });

  // --- Ambiguous partial match (AC-A7: reject + candidate list) ---
  it('ambiguous partial displayName → candidates list', () => {
    // "猫" matches opus ("布偶猫"), opus-45 ("布偶猫 Opus 4.5"), codex ("缅因猫")
    // and is NOT an exact alias for any cat → triggers partial match ambiguity
    const r = normalizeCatId('猫');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'ambiguous');
    assert.ok(r.candidates.length >= 2);
    assert.ok(r.candidates.includes('opus'));
    assert.ok(r.candidates.includes('codex'));
  });

  // --- Exact alias wins over partial displayName (AC-A7) ---
  it('exact alias "opus" wins over partial displayName match', () => {
    // "opus" is an exact catId AND partial match for "布偶猫 Opus 4.5"
    // exact catId should win
    const r = normalizeCatId('opus');
    assert.equal(r.ok, true);
    assert.equal(r.catId, 'opus');
  });

  // --- Nickname partial match (single) ---
  it('unique nickname partial → ok', () => {
    const r = normalizeCatId('砚砚');
    assert.equal(r.ok, true);
    assert.equal(r.catId, 'codex');
  });

  // --- Empty input ---
  it('empty string → not-found', () => {
    const r = normalizeCatId('');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-found');
  });
});
