import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, mock, test } from 'node:test';
import { promisify } from 'node:util';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { FilesystemVerifiedPluginPackageLocator } from '../src/domains/plugin/external-runtime/filesystem-package-locator.js';
import type { PluginInventorySnapshot } from '../src/domains/plugin/host-inventory/types.js';
import { PluginManagerPackageAssetService } from '../src/domains/plugin/manager/plugin-package-assets.js';

const roots: string[] = [];
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8H0z"/></svg>');
const validateMetadata = (value: unknown) => {
  if (!value || typeof value !== 'object') return validateManifest(value);
  const { icon: _icon, description: _description, ...legacy } = value as Record<string, unknown>;
  const result = validateManifest(legacy);
  return result.valid ? { ...result, manifest: structuredClone(value) as typeof result.manifest } : result;
};

afterEach(async () => {
  mock.restoreAll();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture({ catalog = false, duplicate = false, missing = false, oversized = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-static-icon-'));
  roots.push(root);
  const source = join(root, 'source');
  await mkdir(join(source, 'package/assets'), { recursive: true });
  const manifest = {
    pluginId: 'official.static-icon',
    version: '0.1.0',
    contractVersion: '0.1.0',
    name: 'Static icon',
    features: [{ id: 'main', name: 'Main', resources: [], capabilities: [] }],
    runtime: { transport: 'builtin' },
    icon: { type: 'svg', src: 'assets/icon.svg' },
  };
  const validation = validateMetadata(manifest);
  assert.ok(validation.valid, JSON.stringify(validation));
  await writeFile(join(source, 'package/manifest.json'), JSON.stringify(manifest));
  if (!missing)
    await writeFile(join(source, 'package/assets/icon.svg'), oversized ? Buffer.alloc(1024 * 1024 + 1) : svg);
  const { stdout: bytes } = await promisify(execFile)(
    'tar',
    ['-czf', '-', 'package', ...(duplicate ? ['package/assets/icon.svg'] : [])],
    { cwd: source, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 },
  );
  const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const cache = join(root, 'cache');
  const locator = new FilesystemVerifiedPluginPackageLocator(cache, { validateManifest: validateMetadata });
  if (!catalog) {
    await mkdir(locator.packageRoot(digest), { recursive: true });
    await writeFile(join(locator.packageRoot(digest), 'package.tgz'), bytes);
  }
  const snapshot: PluginInventorySnapshot = {
    schemaVersion: 1,
    grants: [],
    packages: catalog
      ? []
      : [
          {
            packageDigest: digest,
            pluginId: manifest.pluginId,
            version: manifest.version,
            contractVersion: manifest.contractVersion,
            manifest: validation.manifest,
            signalSchemas: {},
            packageState: 'installed',
            verifiedAt: 1,
            updatedAt: 1,
          },
        ],
    instances: catalog
      ? []
      : [
          {
            pluginId: manifest.pluginId,
            pluginInstanceId: 'pi_static',
            packageDigest: digest,
            lifecycleState: 'installed',
            configReadiness: 'ready',
            activationState: 'disabled',
            runtimeState: 'stopped',
            lifecycleRevision: 1,
            installedAt: 1,
            updatedAt: 1,
          },
        ],
  };
  const assets = new PluginManagerPackageAssetService({
    inventory: { snapshot: async () => structuredClone(snapshot) },
    packages: locator,
    packagesRoot: cache,
    catalog: {
      snapshot: async () => ({
        status: 'fresh',
        checkedAt: 1,
        entries: [
          {
            catalogId: 'static-icon',
            pluginId: manifest.pluginId,
            version: manifest.version,
            packageName: '@clowder-ai/static-icon',
            distribution: 'registry',
            archiveUrl: 'https://registry.npmjs.org/@clowder-ai/static-icon/-/static-icon-0.1.0.tgz',
            packageDigest: digest,
            presentation: { displayName: manifest.name, icon: manifest.icon, publisher: 'Clowder AI' },
          },
        ],
      }),
    },
    fetchArchive: async () => bytes,
    validateManifest: validateMetadata,
  });
  return {
    assets,
    locator,
    cache,
    snapshot,
    archivePath: join(locator.packageRoot(digest), 'package.tgz'),
    id: manifest.pluginId,
  };
}

test('installed icon reads verified static bytes without preparing an executable package tree', async () => {
  const { assets, locator, id, cache } = await fixture();
  const calls = mock.method(locator, 'resolveInstalledPackage');
  const before = await readdir(cache);
  const asset = await assets.readIcon(id);
  assert.deepEqual(asset.bytes, svg);
  assert.equal(
    calls.mock.callCount(),
    0,
    'a presentation image must not prepare or repeatedly hash an executable tree',
  );
  assert.deepEqual(await readdir(cache), before);
});

test('catalog icon reads verified static bytes without executable staging or publishing', async () => {
  const { assets, id, cache } = await fixture({ catalog: true });
  const calls = mock.method(FilesystemVerifiedPluginPackageLocator.prototype, 'resolvePackageArchiveBytes');
  assert.deepEqual((await assets.readIcon(id)).bytes, svg);
  assert.equal(calls.mock.callCount(), 0, 'catalog images must not prepare an executable tree either');
  assert.deepEqual(await readdir(cache), []);
});

test('ambiguous duplicate icon members are rejected and temporary static reads are released', async () => {
  const { assets, id, cache } = await fixture({ duplicate: true });
  const before = await readdir(cache);
  await assert.rejects(assets.readIcon(id), { code: 'INVALID_ASSET' });
  assert.deepEqual(await readdir(cache), before);
});

test('archive digest changes reject before serving bytes and leave no staging', async () => {
  const { assets, id, cache, archivePath } = await fixture();
  const before = await readdir(cache);
  await appendFile(archivePath, Buffer.from([0]));
  await assert.rejects(assets.readIcon(id), { code: 'INVALID_ASSET' });
  assert.deepEqual(await readdir(cache), before);
});

test('a missing declared icon keeps the explicit asset-not-found response', async () => {
  const { assets, id, cache } = await fixture({ missing: true });
  const before = await readdir(cache);
  await assert.rejects(assets.readIcon(id), { code: 'ASSET_NOT_FOUND' });
  assert.deepEqual(await readdir(cache), before);
});

test('an oversized static output is bounded and its private archive is released', async () => {
  const { assets, id, cache } = await fixture({ oversized: true });
  const before = await readdir(cache);
  await assert.rejects(assets.readIcon(id), { code: 'INVALID_ASSET' });
  assert.deepEqual(await readdir(cache), before);
});

test('current inventory identity still fences the selected archive manifest', async () => {
  const { assets, id, snapshot } = await fixture();
  const record = snapshot.packages[0];
  assert.ok(record?.manifest);
  Object.assign(record.manifest, { version: '0.1.1' });
  await assert.rejects(assets.readIcon(id), { code: 'INVALID_ASSET' });
});

test('a failed static verification never falls back to executable staging', async () => {
  const { assets, id, locator } = await fixture();
  const executions = mock.method(locator, 'resolveInstalledPackage');
  mock.method(locator, 'readInstalledStaticFile', async () => {
    throw new Error('verification refused');
  });
  await assert.rejects(assets.readIcon(id), { code: 'INVALID_ASSET' });
  assert.equal(executions.mock.callCount(), 0);
});

test('returned image buffers do not carry mutable bytes into a later read', async () => {
  const { assets, id } = await fixture();
  const first = await assets.readIcon(id);
  first.bytes.fill(0);
  assert.deepEqual((await assets.readIcon(id)).bytes, svg);
});
