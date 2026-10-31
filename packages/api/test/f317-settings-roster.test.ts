import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONCIERGE_CONFIG_DEFAULTS, catRegistry } from '@cat-cafe/shared';
import { getRoster, loadCatConfig, toAllCatConfigs } from '../src/config/cat-config-loader.js';
import { MemoryConciergeConfigStore } from '../src/domains/concierge/ConciergeConfigStore.js';
import { readCompanionSettingsSource } from '../src/domains/concierge/live/host/companion-settings-read.js';
import { createIsolatedTemplateRoot } from './helpers/isolated-template-root.js';

test('settings availability uses the real registry, roster and native selection rules', async (t) => {
  const isolated = createIsolatedTemplateRoot(
    process.env.TMPDIR ?? '/tmp',
    fileURLToPath(new URL('../../../cat-template.json', import.meta.url)),
  );
  t.after(isolated.cleanup);
  const template = loadCatConfig(isolated.templatePath);
  const cats = Object.values(toAllCatConfigs(template));
  for (const cat of cats) if (!catRegistry.has(cat.id)) catRegistry.register(cat.id, cat);
  const roster = getRoster(template);
  const native = cats.find(
    (cat) => cat.clientId === 'openai' && cat.provider !== 'openai-chatgpt-pro' && roster[cat.id]?.available !== false,
  );
  assert.ok(native);
  const store = new MemoryConciergeConfigStore();
  await store.put('owner', { ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId: native.id });
  const available = await readCompanionSettingsSource(store, 'owner');
  assert.equal(available.status, 'available');
  if (available.status !== 'available') assert.fail('settings unavailable');
  assert.equal(available.selectedCompanionStatus, 'available');
  assert.equal(available.companions.find((row) => row.catProfileId === native.id)?.available, true);
  getRoster({ ...template, roster: { ...roster, [native.id]: { ...roster[native.id], available: false } } });
  const unavailable = await readCompanionSettingsSource(store, 'owner');
  if (unavailable.status !== 'available') assert.fail('configuration is still readable');
  assert.equal(unavailable.config.dutyCatProfileId, native.id);
  assert.equal(unavailable.selectedCompanionStatus, 'unavailable');
  assert.equal(unavailable.companions.find((row) => row.catProfileId === native.id)?.available, false);
  const oldAdapter = { get: store.get.bind(store), put: store.put.bind(store) };
  assert.deepEqual(await readCompanionSettingsSource(oldAdapter, 'owner'), {
    status: 'unavailable',
    reason: 'host_upgrade_required',
  });
});
