import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateHostPluginManifest } from '../src/domains/plugin/desktop-window-runtime/presentation-manifest.js';
import { DEFAULT_PLUGIN_CONTRACT_RUNTIME } from '../src/domains/plugin/host-inventory/contract-policy.js';
import { desktopWindowManifest } from './f317-window.fixture.js';

test('the new manifest reader admits only the delivered companion bridge without expanding generic grants', () => {
  const legacy = desktopWindowManifest(undefined, '1.3.0');
  const published = {
    ...legacy,
    pluginId: 'official.companion',
    version: '0.1.0-alpha.24',
    contributions: legacy.contributions?.map((c) => ({ ...c, bridgeVersion: '1.4.0' })),
  };
  const accepted = DEFAULT_PLUGIN_CONTRACT_RUNTIME.validateManifest(published);
  assert.equal(accepted.valid, true);
  if (accepted.valid)
    assert.deepEqual(accepted.manifest, published, 'manifest bytes are never rewritten to a legacy bridge');
  assert.equal(validateHostPluginManifest(legacy).valid, true);
  for (const foreign of [
    { ...published, pluginId: 'dev.other' },
    { ...published, version: '0.1.0-alpha.25' },
    { ...published, version: '0.1.0-alpha.23' },
    {
      ...published,
      features: published.features.map((f) => ({ ...f, capabilities: ['windows.create', 'files.write'] })),
    },
  ])
    assert.equal(validateHostPluginManifest(foreign).valid, false);
});
