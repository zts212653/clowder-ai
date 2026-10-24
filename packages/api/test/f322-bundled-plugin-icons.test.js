import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { promisify } from 'node:util';
import { validatePluginCatalog } from '@clowder-ai/plugin-contract';
import { fetchOfficialPackageArchive } from '../dist/domains/plugin/bundled-package-source.js';
import { FilesystemVerifiedPluginPackageLocator } from '../dist/domains/plugin/external-runtime/filesystem-package-locator.js';
import { HostInventoryControlPlane } from '../dist/domains/plugin/host-inventory/control-plane.js';
import { MemoryPluginInventoryStore } from '../dist/domains/plugin/host-inventory/stores.js';
import { LEGACY_BUNDLED_MANIFESTS } from '../dist/domains/plugin/legacy-bundled-manifests.js';
import { MachineOfficialPluginCatalog } from '../dist/domains/plugin/manager/machine-catalog-provider.js';
import { projectPluginManagerCatalogCandidate } from '../dist/domains/plugin/manager/plugin-manager-projection.js';
import { PluginManagerPackageAssetService } from '../dist/domains/plugin/manager/plugin-package-assets.js';
import {
  bundledManifestDigest,
  OFFICIAL_BUNDLED_CATALOG_ENTRIES,
  OFFICIAL_BUNDLED_MANIFESTS,
  OFFICIAL_PLUGIN_CATALOG,
} from '../dist/domains/plugin/official-catalog.js';
import { OfficialPluginPackageInstaller } from '../dist/domains/plugin/official-package-installer.js';
import { OfficialPluginManagerCatalogAdapter } from '../dist/domains/plugin/runtime-composition.js';

function offlineHostCatalog() {
  return new MachineOfficialPluginCatalog({
    loadCatalog: async () => {
      throw new Error('offline machine registry');
    },
    validateCatalog: validatePluginCatalog,
    hostPolicies: [],
    bundledEntries: OFFICIAL_BUNDLED_CATALOG_ENTRIES,
  });
}

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

for (const pluginId of ['official.chatgpt-dot']) {
  test(`${pluginId}: offline candidate and installed icon use the same verified archive`, async () => {
    const manifest = OFFICIAL_BUNDLED_MANIFESTS.find((candidate) => candidate.pluginId === pluginId);
    const entry = OFFICIAL_PLUGIN_CATALOG.find((candidate) => candidate.pluginId === pluginId);
    assert.ok(manifest);
    assert.ok(entry);
    assert.equal(typeof manifest.icon, 'object', 'the canonical bundled manifest must declare its packaged icon');
    assert.equal(manifest.version, '0.1.2', 'canonical encoding is a new release, not a rewrite of 0.1.1');
    const root = await mkdtemp(join(tmpdir(), 'f322-bundled-icons-'));
    roots.push(root);
    const store = new MemoryPluginInventoryStore();
    const inventory = new HostInventoryControlPlane(store);
    const provider = offlineHostCatalog();
    const discovery = await new OfficialPluginManagerCatalogAdapter(provider, OFFICIAL_BUNDLED_MANIFESTS).snapshot();
    assert.deepEqual(
      discovery.candidates.map((candidate) => candidate.pluginId).sort(),
      ['official.chatgpt-dot'],
      'the production Host bundle list discovers all registered candidates even while registry is offline',
    );
    assert.deepEqual(discovery.candidates.find((candidate) => candidate.pluginId === pluginId).icon, manifest.icon);
    const locator = new FilesystemVerifiedPluginPackageLocator(root);
    const assets = new PluginManagerPackageAssetService({
      inventory: store,
      packages: locator,
      packagesRoot: root,
      catalog: provider,
    });
    const before = await store.snapshot();
    const candidate = await assets.readIcon(pluginId);
    assert.equal(candidate.contentType, 'image/svg+xml');
    assert.match(candidate.bytes.toString('utf8'), /<svg\b/);
    assert.deepEqual(await store.snapshot(), before, 'discovery does not install or change inventory');
    assert.deepEqual(await readdir(root), [], 'discovery releases staging and never publishes an installed cache');
    const installer = new OfficialPluginPackageInstaller({ inventory, packagesRoot: root, catalogProvider: provider });
    await installer.install(entry.catalogId, { version: entry.version, packageDigest: entry.packageDigest });
    const installed = await assets.readIcon(pluginId);
    assert.deepEqual(installed.bytes, candidate.bytes);
    assert.equal(installed.etag, candidate.etag);
    const snapshot = await store.snapshot();
    assert.equal(snapshot.instances.length, 1);
    assert.equal(snapshot.instances[0]?.activationState, 'disabled');
    assert.equal(snapshot.packages[0]?.packageDigest, entry.packageDigest);
  });
}

test('unknown identities, versions, digests and caller-selected paths cannot select a bundled archive', async () => {
  const entry = OFFICIAL_PLUGIN_CATALOG.find((candidate) => candidate.catalogId === 'chatgpt-dot');
  assert.ok(entry);
  for (const delta of [
    { catalogId: '../chatgpt-dot' },
    { pluginId: 'unknown.builtin' },
    { version: '99.0.0' },
    { packageDigest: `sha512-${Buffer.alloc(64).toString('base64')}` },
    { archiveUrl: 'file:///etc/passwd' },
  ]) {
    await assert.rejects(fetchOfficialPackageArchive({ ...entry, ...delta }), /does not register/);
  }
});

test('injected bytes still pass the immutable digest boundary before archive admission', async () => {
  const entry = OFFICIAL_PLUGIN_CATALOG.find((candidate) => candidate.catalogId === 'chatgpt-dot');
  assert.ok(entry);
  const bytes = Buffer.from(await fetchOfficialPackageArchive(entry));
  bytes[bytes.length - 1] ^= 1;
  const root = await mkdtemp(join(tmpdir(), 'f322-bundled-corrupt-'));
  roots.push(root);
  const store = new MemoryPluginInventoryStore();
  const before = await store.snapshot();
  const installer = new OfficialPluginPackageInstaller({
    inventory: new HostInventoryControlPlane(store),
    packagesRoot: root,
    catalog: [entry],
    fetchArchive: async () => bytes,
  });
  await assert.rejects(
    installer.install(entry.catalogId, { version: entry.version, packageDigest: entry.packageDigest }),
    (error) => error instanceof Error && 'code' in error && error.code === 'PACKAGE_DIGEST_MISMATCH',
  );
  assert.deepEqual(await store.snapshot(), before);
  assert.deepEqual(await readdir(root), []);
});

test('unknown bundled archive registration is denied even when an injected fetcher would supply bytes', async () => {
  const entry = OFFICIAL_PLUGIN_CATALOG.find((candidate) => candidate.catalogId === 'chatgpt-dot');
  assert.ok(entry);
  const unknown = { ...entry, pluginId: 'unknown.builtin' };
  const root = await mkdtemp(join(tmpdir(), 'f322-bundled-unregistered-'));
  roots.push(root);
  const store = new MemoryPluginInventoryStore();
  let fetched = false;
  const installer = new OfficialPluginPackageInstaller({
    inventory: new HostInventoryControlPlane(store),
    packagesRoot: root,
    catalog: [unknown],
    fetchArchive: async () => {
      fetched = true;
      return Buffer.alloc(0);
    },
  });
  await assert.rejects(
    installer.install(unknown.catalogId, { version: unknown.version, packageDigest: unknown.packageDigest }),
    (error) => error instanceof Error && 'code' in error && error.code === 'INVALID_PACKAGE_SCHEMA',
  );
  assert.equal(fetched, false);
  assert.equal((await store.snapshot()).instances.length, 0);
});

for (const legacy of LEGACY_BUNDLED_MANIFESTS.filter((manifest) => manifest.pluginId === 'official.chatgpt-dot')) {
  test(`${legacy.pluginId}: a new catalog cannot replace an old installed manifest or icon`, async () => {
    const current = OFFICIAL_PLUGIN_CATALOG.find((candidate) => candidate.pluginId === legacy.pluginId);
    assert.ok(current);
    const previous = {
      ...current,
      version: legacy.version,
      bundledFormat: 'manifest',
      packageDigest: bundledManifestDigest(legacy),
    };
    const root = await mkdtemp(join(tmpdir(), 'f322-bundled-legacy-'));
    roots.push(root);
    const store = new MemoryPluginInventoryStore();
    const installer = new OfficialPluginPackageInstaller({
      inventory: new HostInventoryControlPlane(store),
      packagesRoot: root,
      catalog: [previous],
    });
    await installer.install(previous.catalogId, { version: previous.version, packageDigest: previous.packageDigest });
    const before = await store.snapshot();
    let fetched = false;
    const discovery = await new OfficialPluginManagerCatalogAdapter(
      offlineHostCatalog(),
      OFFICIAL_BUNDLED_MANIFESTS,
    ).snapshot();
    const candidate = discovery.candidates.find((item) => item.pluginId === legacy.pluginId);
    assert.ok(candidate);
    const listed = projectPluginManagerCatalogCandidate(candidate, before);
    assert.equal(listed.installedVersion, '0.1.0');
    assert.equal(listed.icon, undefined, 'legacy installed presentation must not borrow the new candidate icon');
    const assets = new PluginManagerPackageAssetService({
      inventory: store,
      packages: new FilesystemVerifiedPluginPackageLocator(root),
      packagesRoot: root,
      catalog: offlineHostCatalog(),
      fetchArchive: async () => {
        fetched = true;
        return fetchOfficialPackageArchive(current);
      },
    });
    // An explicit asset GET cannot substitute a catalog icon for this icon-less legacy package.
    await assert.rejects(
      assets.readIcon(legacy.pluginId),
      (error) => error instanceof Error && 'code' in error && error.code === 'INVALID_ASSET',
    );
    assert.equal(fetched, false);
    assert.deepEqual(await store.snapshot(), before);
    assert.equal(before.packages[0]?.version, '0.1.0');
    assert.equal('icon' in before.packages[0].manifest, false);
    assert.deepEqual(await readdir(root), []);
  });
}

test('the shared registry downloader retains its npm HTTPS boundary', async () => {
  const entry = OFFICIAL_PLUGIN_CATALOG.find((candidate) => candidate.distribution === 'registry');
  assert.ok(entry);
  await assert.rejects(fetchOfficialPackageArchive({ ...entry, archiveUrl: 'file:///etc/passwd' }));
  await assert.rejects(fetchOfficialPackageArchive({ ...entry, archiveUrl: 'https://example.invalid/plugin.tgz' }));
});

for (const layout of ['src', 'dist']) {
  test(`real ${layout} reads built archives from outside the source cwd`, async () => {
    const provider = new URL(
      `../${layout}/domains/plugin/bundled-package-source.${layout === 'src' ? 'ts' : 'js'}`,
      import.meta.url,
    ).href;
    const catalog = new URL(
      `../${layout}/domains/plugin/official-catalog.${layout === 'src' ? 'ts' : 'js'}`,
      import.meta.url,
    ).href;
    const code =
      `const {fetchOfficialPackageArchive}=await import(${JSON.stringify(provider)});` +
      `const {OFFICIAL_PLUGIN_CATALOG}=await import(${JSON.stringify(catalog)});` +
      `const {createHash}=await import('node:crypto');const rows=[];` +
      `for(const row of OFFICIAL_PLUGIN_CATALOG.filter(x=>x.bundledFormat==='archive')){` +
      `const bytes=await fetchOfficialPackageArchive(row);rows.push({id:row.pluginId,bytes:bytes.length,` +
      `digest:'sha512-'+createHash('sha512').update(bytes).digest('base64')});}` +
      `process.stdout.write(JSON.stringify(rows));`;
    const consumerRoot = await mkdtemp(join(tmpdir(), 'f322-bundled-consumer-'));
    roots.push(consumerRoot);
    const consumer = join(consumerRoot, 'consumer.mjs');
    await writeFile(consumer, code);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        ...(layout === 'src' ? ['--import', new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href] : []),
        consumer,
      ],
      {
        cwd: tmpdir(),
      },
    );
    const rows = JSON.parse(stdout);
    assert.equal(rows.length, OFFICIAL_BUNDLED_CATALOG_ENTRIES.length);
    for (const row of rows) {
      const expected = OFFICIAL_PLUGIN_CATALOG.find((entry) => entry.pluginId === row.id);
      assert.ok(expected);
      assert.equal(row.digest, expected.packageDigest);
      const bytes = await fetchOfficialPackageArchive(expected);
      assert.equal(row.bytes, bytes.length);
      assert.equal(row.digest, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
    }
  });
}

// The release contract includes canonical manifest + asset bytes + generated SRI.
test('shipped bundled artifacts match their canonical producer inputs', async () => {
  const script = new URL('../scripts/copy-bundled-plugin-packages.mjs', import.meta.url);
  await promisify(execFile)(process.execPath, [script.pathname, '--check'], {
    cwd: new URL('..', import.meta.url),
  });
});
