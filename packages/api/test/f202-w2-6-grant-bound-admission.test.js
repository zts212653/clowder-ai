/**
 * F202 W2-6 — a Host grant bound is an upper bound, not a quota (astra's review of `16bf05b705`,
 * Host thread …000075, P2). Every admission path grants what the package requests within the bound:
 * a package asking for less (an older release, or a later one that dropped a capability) still
 * installs and updates, with less; asking for more gets no more. The inventory's own check stays
 * strict — an admission candidate may never carry a grant its package does not request.
 *
 * This file covers the official catalog paths (install, update); the local path and the startup
 * reconciliation are in f202-w2-6-official-connector-grants.test.js.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostInventoryControlPlane, MemoryPluginInventoryStore } from '../dist/domains/plugin/index.js';
import { OFFICIAL_PLUGIN_CATALOG } from '../dist/domains/plugin/official-catalog.js';
import { OfficialPluginPackageInstaller } from '../dist/domains/plugin/official-package-installer.js';
import {
  catalogEntry,
  harness,
  manifest,
  packageArchive,
  releaseFence,
} from './plugin-official-package-installer.fixture.js';

const BOUND = ['events.publish', 'plugin.config.read'];
const requesting = (capabilities, overrides = {}) =>
  manifest({ features: [{ id: 'source', name: 'Source', resources: [], capabilities }], ...overrides });
const sorted = (values) => [...values].sort();

test('a catalog install grants what the package requests within the catalog bound', async () => {
  const cases = [
    ['fewer', ['events.publish'], ['events.publish']],
    ['equal', BOUND, BOUND],
    ['more', [...BOUND, 'secret.read'], BOUND],
  ];
  for (const [name, requested, granted] of cases) {
    const archive = await packageArchive({ packageManifest: requesting(requested) });
    const entry = catalogEntry(archive.integrity, { effectiveGrants: BOUND });
    const { store, installer } = await harness(archive, entry);

    await installer.install(entry.catalogId, releaseFence(entry));

    const [grants] = (await store.snapshot()).grants;
    assert.deepEqual(grants.effectiveGrants, sorted(granted), name);
    assert.deepEqual(grants.requestedCapabilities, sorted(requested), name);
  }
});

test('a catalog update re-bounds the grant by the new release request, both ways', async () => {
  const first = await packageArchive({ packageManifest: requesting(['events.publish']) });
  const firstEntry = catalogEntry(first.integrity, { effectiveGrants: BOUND });
  const { store, inventory, packagesRoot, installer } = await harness(first, firstEntry);
  await installer.install(firstEntry.catalogId, releaseFence(firstEntry));
  const current = async () => {
    const snapshot = await store.snapshot();
    const instance = snapshot.instances.find((candidate) => candidate.lifecycleState === 'installed');
    return { instance, grants: snapshot.grants.find((grant) => grant.pluginInstanceId === instance.pluginInstanceId) };
  };
  const updateTo = async (version, capabilities) => {
    const archive = await packageArchive({ packageManifest: requesting(capabilities, { version }) });
    const entry = catalogEntry(archive.integrity, {
      version,
      effectiveGrants: BOUND,
      archiveUrl: `https://registry.npmjs.org/@clowder-ai/official-test-source/-/official-test-source-${version}.tgz`,
    });
    const next = new OfficialPluginPackageInstaller({
      inventory,
      packagesRoot,
      catalog: [entry],
      fetchArchive: async () => archive.bytes,
    });
    const { instance } = await current();
    await next.update(entry.catalogId, instance.pluginInstanceId, instance.lifecycleRevision, releaseFence(entry));
    return (await current()).grants;
  };

  assert.deepEqual((await current()).grants.effectiveGrants, ['events.publish']);
  assert.deepEqual((await updateTo('0.1.0-alpha.2', BOUND)).effectiveGrants, sorted(BOUND), 'widened to the request');
  assert.deepEqual(
    (await updateTo('0.1.0-alpha.3', ['events.publish'])).effectiveGrants,
    ['events.publish'],
    'narrowed with a release that dropped a capability',
  );
});

test('a bundled catalog package is bounded by its own manifest request the same way', async () => {
  // The Collective Connector ships inside the Host and requests no capability at all.
  const bundled = OFFICIAL_PLUGIN_CATALOG.find((entry) => entry.distribution === 'bundled');
  const entry = { ...bundled, effectiveGrants: ['plugin.config.read'] };
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_bundled', now: () => 1 });
  const installer = new OfficialPluginPackageInstaller({
    inventory,
    packagesRoot: '/nonexistent-bundled-packages-root',
    catalog: [entry],
    fetchArchive: async () => assert.fail('a bundled package is never fetched'),
  });

  await installer.install(entry.catalogId, releaseFence(entry));

  assert.deepEqual((await store.snapshot()).grants[0].effectiveGrants, []);
});

test('the inventory still refuses a candidate carrying a grant its package does not request', async () => {
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_strict', now: () => 1 });
  const archive = await packageArchive({ packageManifest: requesting(['events.publish']) });
  await assert.rejects(
    inventory.installPackage({
      manifest: requesting(['events.publish']),
      computedPackageDigest: archive.integrity,
      expectedPackageDigest: archive.integrity,
      packagePluginId: 'official.test-source',
      effectiveGrants: BOUND,
      signalSchemas: { 'schemas/official.test.v1.schema.json': { type: 'object' } },
    }),
    (error) => error?.code === 'INVALID_GRANT' && /subset of manifest requests/.test(error.message),
  );
});
