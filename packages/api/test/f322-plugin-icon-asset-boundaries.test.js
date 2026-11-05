import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { promisify } from 'node:util';
import {
  FilesystemVerifiedPluginPackageLocator,
  MemoryPluginInventoryStore,
  PluginManagerPackageAssetService,
} from '../dist/domains/plugin/index.js';
import { catalogEntry, manifest } from './plugin-official-package-installer.fixture.js';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

for (const scenario of [
  { name: 'missing declared file', path: 'assets/icon.svg', expected: 'ASSET_NOT_FOUND' },
  { name: 'package traversal', path: '../outside.svg', expected: 'INVALID_ASSET' },
  { name: 'linked asset', path: 'assets/icon.svg', expected: 'INVALID_ASSET', linked: true },
]) {
  test(`candidate icon rejects ${scenario.name} without installing or retaining staging`, async () => {
    const source = await mkdtemp(join(tmpdir(), 'f322-icon-boundary-source-'));
    const cache = await mkdtemp(join(tmpdir(), 'f322-icon-boundary-cache-'));
    roots.push(source, cache);
    const packageRoot = join(source, 'package');
    await mkdir(join(packageRoot, 'assets'), { recursive: true });
    const packageManifest = manifest({
      icon: { type: 'svg', src: scenario.path },
      signals: undefined,
      runtime: { transport: 'builtin' },
    });
    await writeFile(join(packageRoot, 'manifest.json'), JSON.stringify(packageManifest));
    await writeFile(join(source, 'outside.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    if (scenario.linked) await symlink(join(source, 'outside.svg'), join(packageRoot, 'assets/icon.svg'));
    const archivePath = join(source, 'package.tgz');
    await promisify(execFile)('tar', ['-czf', archivePath, '-C', source, 'package']);
    const bytes = await readFile(archivePath);
    const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const entry = catalogEntry(digest, {});
    const store = new MemoryPluginInventoryStore();
    const before = await store.snapshot();
    const assets = new PluginManagerPackageAssetService({
      inventory: store,
      packages: new FilesystemVerifiedPluginPackageLocator(cache),
      packagesRoot: cache,
      catalog: { snapshot: async () => ({ entries: [entry], status: 'fresh', checkedAt: 1 }) },
      fetchArchive: async () => bytes,
    });
    await assert.rejects(
      assets.readIcon(packageManifest.pluginId),
      (error) => error instanceof Error && 'code' in error && error.code === scenario.expected,
    );
    assert.deepEqual(await store.snapshot(), before);
    assert.deepEqual(await readdir(cache), []);
  });
}
