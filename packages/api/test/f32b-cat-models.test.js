/**
 * F32-b: getCatModel dynamic env key tests
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { getCatModel, getAllCatModels } = await import('../dist/config/cat-models.js');

describe('F32-b: getCatModel dynamic env key', () => {
  it('resolves default model from catRegistry', () => {
    // catRegistry is populated by setup-cat-registry.js from runtime config
    const model = getCatModel('opus');
    assert.ok(typeof model === 'string');
    assert.ok(model.length > 0);
  });

  it('env var takes highest priority (CAT_OPUS_MODEL)', () => {
    const saved = process.env.CAT_OPUS_MODEL;
    process.env.CAT_OPUS_MODEL = 'test-model-override';
    try {
      assert.equal(getCatModel('opus'), 'test-model-override');
    } finally {
      if (saved === undefined) delete process.env.CAT_OPUS_MODEL;
      else process.env.CAT_OPUS_MODEL = saved;
    }
  });

  it('hyphenated catId generates correct env key (CAT_OPUS_45_MODEL)', () => {
    const saved = process.env.CAT_OPUS_45_MODEL;
    process.env.CAT_OPUS_45_MODEL = 'sonnet-override';
    try {
      assert.equal(getCatModel('opus-45'), 'sonnet-override');
    } finally {
      if (saved === undefined) delete process.env.CAT_OPUS_45_MODEL;
      else process.env.CAT_OPUS_45_MODEL = saved;
    }
  });

  it('throws for unknown cat (no env, no registry entry)', () => {
    assert.throws(() => getCatModel('nonexistent-cat-xyz'), /No model configured/);
  });

  // clowder-ai#1796: a caller-supplied `''` is a VALUE, not a missing value.
  // `GET /api/cats` projects members from the resolved catalog before they are
  // reconciled into the process registry and passes `cat.defaultModel` verbatim;
  // a legal empty model used to fall through to the throw and 500 the whole page.
  it('accepts an explicitly passed empty configuredFallback (#1796)', () => {
    assert.equal(getCatModel('not-in-registry-1796', ''), '');
  });

  it('still throws when configuredFallback is omitted entirely (#1796)', () => {
    assert.throws(() => getCatModel('not-in-registry-1796'), /No model configured/);
  });

  it('accepts a non-empty configuredFallback (unchanged behavior)', () => {
    assert.equal(getCatModel('not-in-registry-1796', 'fallback-model'), 'fallback-model');
  });

  // Guard the precedence the #1796 fix sits next to: the empty-value acceptance
  // must not promote '' above an explicit env override.
  it('a non-empty CAT_*_MODEL env var still wins over an empty fallback (#1796)', () => {
    const saved = process.env.CAT_ENV_WINS_1796_MODEL;
    process.env.CAT_ENV_WINS_1796_MODEL = 'env-override-model';
    try {
      assert.equal(getCatModel('env-wins-1796', ''), 'env-override-model');
    } finally {
      if (saved === undefined) delete process.env.CAT_ENV_WINS_1796_MODEL;
      else process.env.CAT_ENV_WINS_1796_MODEL = saved;
    }
  });

  it('getAllCatModels returns models for all registered cats', () => {
    const all = getAllCatModels();
    assert.ok(all.opus);
    assert.ok(all.codex);
    assert.ok(all.gemini);
  });
});
