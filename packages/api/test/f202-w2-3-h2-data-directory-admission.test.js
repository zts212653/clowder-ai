/**
 * F202 W2-3 h2 — which data directory a package can be given, and how admission keeps plugins
 * apart (ledger「W2-3 契约冻结」h2 ③, contract beta.24 `runtime.dataDirectory` /
 * `data.directory`).
 *
 * The name is declared, or derived from the plugin id. Every admission (install, upgrade,
 * reinstall) refuses a name that another installed plugin holds, or that the Host keeps its own
 * files under in `.cat-cafe/plugin-host` (the layout table is the single truth for those); the
 * installers pass that on as DATA_DIRECTORY_IN_USE.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  isHostReservedDataDirectoryName,
  requestedDataDirectoryName,
} from '../dist/domains/plugin/host-inventory/data-directory-name.js';
import { PLUGIN_HOST_ENTRIES } from '../dist/domains/plugin/host-inventory/plugin-host-layout.js';
import { HostInventoryControlPlane, MemoryPluginInventoryStore } from '../dist/domains/plugin/index.js';
import {
  catalogEntry,
  harness as catalogHarness,
  manifest as catalogManifest,
  isInstallError,
  packageArchive,
  releaseFence,
} from './plugin-official-package-installer.fixture.js';

function manifest(overrides = {}) {
  return {
    pluginId: 'dev.clowder.h2-fixture',
    version: '0.1.0',
    contractVersion: '0.1.0',
    name: 'H2 fixture',
    features: [{ id: 'main', name: 'Main', resources: [], capabilities: ['data.directory'] }],
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js', dataDirectory: 'personal-chrome-host' },
    ...overrides,
  };
}

const noCapabilities = [{ id: 'main', name: 'Main', resources: [], capabilities: [] }];
const digestOf = (seed) => `sha512-${createHash('sha512').update(seed).digest('base64')}`;

test('the directory name: declared, else the plugin id when valid, else a hash of the id', () => {
  assert.equal(requestedDataDirectoryName(manifest()), 'personal-chrome-host');
  const undeclared = manifest({ runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' } });
  assert.equal(requestedDataDirectoryName(undeclared), 'dev.clowder.h2-fixture');
  const odd = { ...undeclared, pluginId: 'Dev.Clowder/Fixture' };
  assert.match(requestedDataDirectoryName(odd), /^plugin-[0-9a-f]{16}$/);
  assert.notEqual(
    requestedDataDirectoryName(odd),
    requestedDataDirectoryName({ ...odd, pluginId: 'Dev.Clowder/Other' }),
  );
  assert.equal(requestedDataDirectoryName(manifest({ features: noCapabilities })), undefined);
  assert.equal(
    requestedDataDirectoryName(manifest({ runtime: { transport: 'stdio', entrypoint: 'dist/plugin.js' } })),
    undefined,
  );
});

test('install and upgrade refuse a second plugin that wants the same directory, naming who holds it', async () => {
  const store = new MemoryPluginInventoryStore();
  let next = 0;
  const inventory = new HostInventoryControlPlane(store, { createInstanceId: () => `pi_${++next}`, now: () => 1 });
  const install = (packageManifest, seed, effectiveGrants = ['data.directory']) =>
    inventory.installPackage({
      manifest: packageManifest,
      computedPackageDigest: digestOf(seed),
      expectedPackageDigest: digestOf(seed),
      packagePluginId: packageManifest.pluginId,
      effectiveGrants,
    });
  const inUse = (error) =>
    error?.code === 'DATA_DIRECTORY_IN_USE' &&
    error.message.includes('personal-chrome-host') &&
    error.message.includes('dev.clowder.h2-fixture');
  await install(manifest(), 'holder');

  await assert.rejects(install(manifest({ pluginId: 'dev.clowder.rival' }), 'rival'), inUse);
  // Only installed plugins hold a name: once the holder is retired the name is free again.
  const setState = (pluginInstanceId, lifecycleState) =>
    store.transaction((transaction) => {
      const { retiredAt: _previous, ...instance } = transaction.instances.get(pluginInstanceId);
      transaction.instances.put({
        ...instance,
        lifecycleState,
        ...(lifecycleState === 'retired' ? { retiredAt: 2 } : {}),
      });
    });
  await setState('pi_1', 'retired');
  const rival = await install(manifest({ pluginId: 'dev.clowder.rival' }), 'rival');
  await setState(rival.pluginInstanceId, 'retired');
  await setState('pi_1', 'installed');

  const bystander = manifest({ pluginId: 'dev.clowder.bystander', features: noCapabilities });
  const admitted = await install(bystander, 'bystander', []);
  await assert.rejects(
    inventory.upgradePackage({
      pluginInstanceId: admitted.pluginInstanceId,
      expectedLifecycleRevision: 1,
      expectedGrantRevision: 1,
      manifest: manifest({ pluginId: 'dev.clowder.bystander', version: '0.2.0' }),
      computedPackageDigest: digestOf('bystander-2'),
      expectedPackageDigest: digestOf('bystander-2'),
      packagePluginId: 'dev.clowder.bystander',
      effectiveGrants: ['data.directory'],
    }),
    inUse,
  );
  await inventory.upgradePackage({
    pluginInstanceId: 'pi_1',
    expectedLifecycleRevision: 1,
    expectedGrantRevision: 1,
    manifest: manifest({ version: '0.2.0' }),
    computedPackageDigest: digestOf('holder-2'),
    expectedPackageDigest: digestOf('holder-2'),
    packagePluginId: 'dev.clowder.h2-fixture',
    effectiveGrants: ['data.directory'],
  });
});

test('a name the Host keeps its own files under is never given to a plugin', async () => {
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_reserved', now: () => 1 });
  for (const packageManifest of [
    manifest({ runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js', dataDirectory: 'packages' } }),
    manifest({ runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js', dataDirectory: 'inventory.json' } }),
    manifest({ pluginId: 'resources', runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' } }),
  ]) {
    await assert.rejects(
      inventory.installPackage({
        manifest: packageManifest,
        computedPackageDigest: digestOf(JSON.stringify(packageManifest)),
        expectedPackageDigest: digestOf(JSON.stringify(packageManifest)),
        packagePluginId: packageManifest.pluginId,
        effectiveGrants: ['data.directory'],
      }),
      (error) => error?.code === 'DATA_DIRECTORY_IN_USE' && error.message.includes('reserved'),
    );
  }
  assert.equal((await store.snapshot()).instances.length, 0);
});

test('the Host names its plugin-host entries only through the layout table, which is what is reserved', async () => {
  const sources = new Map();
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.ts')) sources.set(path, await readFile(path, 'utf8'));
    }
  };
  const srcRoot = new URL('../src', import.meta.url).pathname;
  await walk(srcRoot);
  // The F247 copy that h3 deletes still builds its own `personal-chrome-host` path (h2 ⑦).
  const mayNameTheRoot = new Set([
    join(srcRoot, 'domains/plugin/host-inventory/plugin-host-layout.ts'),
    join(srcRoot, 'domains/cats/services/cloud-bridge/personal-chrome-host/personal-chrome-host-adapter.ts'),
  ]);
  // Where the Host builds a child from a variable, it calls the plugin-host root `hostRoot`.
  const childOfRoot =
    /(?:resolve|join)\((?:dirname\([^)]*inventorySnapshotPath\)|pluginHostRoot\([^)]*\)|hostRoot),\s*([^)]+)\)/g;
  let checked = 0;
  for (const [path, source] of sources) {
    if (source.includes("'plugin-host'"))
      assert.ok(mayNameTheRoot.has(path), `${path} builds the plugin-host root itself`);
    if (!source.includes('inventorySnapshotPath') && !source.includes('pluginHostRoot(')) continue;
    for (const [, child] of source.matchAll(childOfRoot)) {
      if (path.endsWith('personal-chrome-host-adapter.ts')) continue;
      checked += 1;
      assert.match(
        child.trim(),
        /^PLUGIN_HOST_ENTRIES\.\w+$/,
        `${path} names a plugin-host entry outside the table: ${child}`,
      );
    }
  }
  assert.ok(checked >= 11, `the scan must still see the Host's entries (saw ${checked})`);
  for (const name of Object.values(PLUGIN_HOST_ENTRIES))
    assert.equal(isHostReservedDataDirectoryName(name), true, name);
  assert.equal(isHostReservedDataDirectoryName('personal-chrome-host'), false);
});

test('the catalog installer reports the conflict as DATA_DIRECTORY_IN_USE and quarantines nothing', async () => {
  const wantsShared = {
    runtime: { transport: 'builtin', entrypoint: 'dist/entrypoint.js', dataDirectory: 'shared-dir' },
    features: [{ id: 'source', name: 'Source', resources: [], capabilities: ['events.publish', 'data.directory'] }],
  };
  const archive = await packageArchive({ packageManifest: catalogManifest(wantsShared) });
  const entry = catalogEntry(archive.integrity, { effectiveGrants: ['events.publish', 'data.directory'] });
  const { store, installer } = await catalogHarness(archive, entry);
  const holder = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_holder', now: () => 1 });
  await holder.installPackage({
    manifest: manifest({ pluginId: 'dev.clowder.holder', runtime: { ...wantsShared.runtime } }),
    computedPackageDigest: digestOf('catalog-holder'),
    expectedPackageDigest: digestOf('catalog-holder'),
    packagePluginId: 'dev.clowder.holder',
    effectiveGrants: ['data.directory'],
  });

  await assert.rejects(installer.install(entry.catalogId, releaseFence(entry)), (error) => {
    return isInstallError('DATA_DIRECTORY_IN_USE')(error) && error.message.includes('dev.clowder.holder');
  });
  assert.deepEqual(
    (await store.snapshot()).instances.map((instance) => instance.pluginId),
    ['dev.clowder.holder'],
  );
});
