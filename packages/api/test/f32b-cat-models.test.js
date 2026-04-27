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

  it('getAllCatModels returns models for all registered cats', () => {
    const all = getAllCatModels();
    assert.ok(all.opus);
    assert.ok(all.codex);
    assert.ok(all.gemini);
  });
});
