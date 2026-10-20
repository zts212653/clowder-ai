import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { HostInventoryControlPlane, MemoryPluginInventoryStore } from '../dist/domains/plugin/index.js';
import { resolveLocalPluginEffectiveGrants } from '../dist/domains/plugin/manager/machine-catalog-provider.js';
import { reconcileOfficialPluginGrants } from '../dist/domains/plugin/manager/official-plugin-grants.js';
import { OFFICIAL_PLUGIN_HOST_POLICIES } from '../dist/domains/plugin/manager/official-plugin-host-policies.js';

const requested = ['thread.readContent', 'thread.listMetadata', 'messaging.send'];
const sorted = (values) => [...values].sort();
const manifest = (capabilities = requested, pluginId = 'dev.clowder.xiangqi') => ({
  pluginId,
  version: '0.1.0-alpha.2',
  contractVersion: '0.1.0',
  name: 'Xiangqi',
  features: [{ id: 'analyze-position', name: 'Play Xiangqi', resources: [], capabilities }],
  runtime: { transport: 'builtin', entrypoint: 'dist/plugin-entrypoint.mjs', dataDirectory: 'xiangqi' },
});

test('installed Xiangqi receives only its declared conversation and move-notification authority', () => {
  const resolve = (value) => resolveLocalPluginEffectiveGrants(OFFICIAL_PLUGIN_HOST_POLICIES, value);
  assert.deepEqual(sorted(resolve(manifest())), sorted(requested));
  assert.deepEqual(resolve(manifest([])), [], 'older read-only manifests gain no undeclared authority');
  assert.deepEqual(
    sorted(resolve(manifest([...requested, 'secret.read', 'thread.write', 'task.write']))),
    sorted(requested),
  );
  assert.deepEqual(
    resolve(manifest(requested, 'dev.example.xiangqi')),
    [],
    'another package cannot inherit the policy',
  );
});

test('startup repairs a previously installed Xiangqi grant without replacing its retained instance', async () => {
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_xiangqi', now: () => 1 });
  const digest = `sha512-${createHash('sha512').update('xiangqi-installed-grant-recovery').digest('base64')}`;
  await inventory.installPackage({
    manifest: manifest(),
    computedPackageDigest: digest,
    expectedPackageDigest: digest,
    packagePluginId: 'dev.clowder.xiangqi',
    effectiveGrants: [],
  });
  const before = await store.snapshot();
  const changes = await reconcileOfficialPluginGrants({
    store,
    inventory,
    hostPolicies: OFFICIAL_PLUGIN_HOST_POLICIES,
  });
  assert.deepEqual(changes, [
    { pluginId: 'dev.clowder.xiangqi', pluginInstanceId: 'pi_xiangqi', added: sorted(requested), removed: [] },
  ]);
  const after = await store.snapshot();
  assert.deepEqual(after.instances, before.instances);
  assert.deepEqual(after.packages, before.packages);
  assert.deepEqual(sorted(after.grants[0].effectiveGrants), sorted(requested));
  assert.deepEqual(
    await reconcileOfficialPluginGrants({ store, inventory, hostPolicies: OFFICIAL_PLUGIN_HOST_POLICIES }),
    [],
  );
});
