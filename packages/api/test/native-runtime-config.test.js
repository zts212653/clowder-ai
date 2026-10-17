import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { resolveBoundAccountRefForCat } from '../dist/config/cat-account-binding.js';
import { getCatEffort, loadCatConfig, toAllCatConfigs } from '../dist/config/cat-config-loader.js';
import { getCatModel } from '../dist/config/cat-models.js';

const base = catRegistry.tryGet('opus').config;
const native = {
  ...base,
  id: 'native-tool-fixture',
  clientId: 'anthropic',
  configurationSource: 'native_tool',
  defaultModel: '',
  accountRef: 'legacy-kitcoding',
  cli: { command: 'claude', outputFormat: 'stream-json' },
};
catRegistry.register('native-tool-fixture', native);

describe('native role configuration', () => {
  it('does not backfill a role model from legacy app environment', () => {
    const saved = process.env.CAT_NATIVE_TOOL_FIXTURE_MODEL;
    process.env.CAT_NATIVE_TOOL_FIXTURE_MODEL = 'legacy-forced-model';
    try {
      assert.equal(getCatModel('native-tool-fixture'), '');
    } finally {
      if (saved === undefined) delete process.env.CAT_NATIVE_TOOL_FIXTURE_MODEL;
      else process.env.CAT_NATIVE_TOOL_FIXTURE_MODEL = saved;
    }
  });
  it('preserves an explicit account independently from native model inheritance', () => {
    assert.equal(resolveBoundAccountRefForCat('', native.id, native), 'legacy-kitcoding');
  });
  it('omits the app effort default in native mode', () => {
    const cfg = structuredClone(loadCatConfig());
    const variant = cfg.breeds[0].variants[0];
    variant.configurationSource = 'native_tool';
    delete variant.cli.effort;
    assert.equal(getCatEffort(variant.catId ?? cfg.breeds[0].catId, cfg), '');
  });
  it('preserves native source through the catalog projection', () => {
    const cfg = structuredClone(loadCatConfig());
    cfg.breeds[0].variants[0].configurationSource = 'native_tool';
    const configs = Object.values(toAllCatConfigs(cfg));
    assert.equal(configs[0].configurationSource, 'native_tool');
  });
  it('keeps independent explicit native model and effort overrides', () => {
    const cfg = structuredClone(loadCatConfig());
    const variant = cfg.breeds[0].variants[0];
    variant.configurationSource = 'native_tool';
    variant.cli.effort = 'low';
    assert.equal(getCatEffort(variant.catId ?? cfg.breeds[0].catId, cfg), 'low');
  });
});
