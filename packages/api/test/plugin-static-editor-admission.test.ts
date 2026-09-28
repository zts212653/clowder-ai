import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PluginManifest } from '@clowder-ai/plugin-contract';
import { staticEditorFixture as fixture, staticEditorManifest as manifest } from './plugin-static-editor.fixture.js';

test('exact archive admits a public static editor into disabled inventory without starting it', async (t) => {
  const f = await fixture(manifest());
  t.after(f.cleanup);
  await f.install();
  const snapshot = await f.store.snapshot();
  assert.equal(snapshot.instances.length, 1);
  assert.equal(snapshot.instances[0].activationState, 'disabled');
  assert.equal(snapshot.instances[0].runtimeState, 'stopped');
  assert.equal(snapshot.instances[0].configReadiness, 'incomplete');
  assert.deepEqual(snapshot.grants[0].effectiveGrants, []);
});

test('a signed archive with an incorrect renderer SRI is rejected before inventory admission', async (t) => {
  const f = await fixture(manifest(), '<script>changed</script>');
  t.after(f.cleanup);
  await assert.rejects(f.install(), /surface integrity/i);
  assert.equal((await f.store.snapshot()).instances.length, 0);
});

for (const [name, mutation] of [
  [
    'executable entrypoint',
    (m: PluginManifest) => ({ ...m, runtime: { transport: 'builtin' as const, entrypoint: 'renderer/code.js' } }),
  ],
  [
    'effect capability',
    (m: PluginManifest) => ({ ...m, features: [{ ...m.features[0], capabilities: ['events.publish' as const] }] }),
  ],
  [
    'configuration',
    (m: PluginManifest) => ({ ...m, configuration: [{ key: 'secret', type: 'string' as const, required: true }] }),
  ],
  [
    'data namespace',
    (m: PluginManifest) => ({
      ...m,
      data: [{ name: 'hidden', dataClass: 'relationship' as const, strategy: 'retained' as const, schemaVersion: '1' }],
    }),
  ],
] as const) {
  test(`static admission does not allow ${name} through the builtin transport`, async (t) => {
    const f = await fixture(mutation(manifest()) as PluginManifest);
    t.after(f.cleanup);
    await assert.rejects(f.install());
    assert.equal((await f.store.snapshot()).instances.length, 0);
  });
}
