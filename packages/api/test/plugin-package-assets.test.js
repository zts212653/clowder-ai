import assert from 'node:assert/strict';
import { readdir, rm } from 'node:fs/promises';
import { afterEach, describe, it } from 'node:test';
import { validateEffectiveGrants, validateManifest } from '@clowder-ai/plugin-contract';

import {
  FilesystemVerifiedPluginPackageLocator,
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
  PluginManagerPackageAssetError,
  PluginManagerPackageAssetService,
} from '../dist/domains/plugin/index.js';
import { catalogEntry, manifest, packageArchive } from './plugin-official-package-installer.fixture.js';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function metadataContractRuntime() {
  return {
    manifestContractVersions: ['0.1.0'],
    validateEffectiveGrants,
    validateManifest(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return validateManifest(value);
      const { description: _description, icon: _icon, ...legacy } = value;
      const validation = validateManifest(legacy);
      return validation.valid ? { valid: true, manifest: structuredClone(value) } : validation;
    },
  };
}

async function fixture({ icon, iconBytes, readme, catalogOnly = false }) {
  const packageManifest = manifest({
    description: 'Verified package asset fixture',
    icon,
    signals: undefined,
  });
  const archive = await packageArchive({
    packageManifest,
    extraFiles: {
      [icon.src]: iconBytes,
      ...(readme === undefined ? {} : { 'README.md': Buffer.from(readme) }),
    },
  });
  const entry = catalogEntry(archive.integrity, {
    pluginId: packageManifest.pluginId,
    version: packageManifest.version,
    presentation: {
      displayName: packageManifest.name,
      description: 'Verified package asset fixture',
      icon,
      publisher: 'Clowder AI',
    },
  });
  const store = new MemoryPluginInventoryStore(undefined, { contract: metadataContractRuntime() });
  const inventory = new HostInventoryControlPlane(store, {
    contract: metadataContractRuntime(),
    createInstanceId: () => 'pi_asset',
    now: () => 10_000,
  });
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'cat-cafe-f202-assets-'));
  roots.push(root);
  const locator = new FilesystemVerifiedPluginPackageLocator(root, {
    validateManifest: metadataContractRuntime().validateManifest,
  });
  if (!catalogOnly) {
    const located = await locator.resolvePackageArchiveBytes(archive.integrity, archive.bytes);
    try {
      const { publishPluginPackageArchive } = await import('../dist/domains/plugin/index.js');
      await publishPluginPackageArchive(root, archive.integrity, archive.bytes);
      await inventory.installPackage({
        manifest: located.manifest,
        computedPackageDigest: archive.integrity,
        expectedPackageDigest: archive.integrity,
        packagePluginId: packageManifest.pluginId,
        effectiveGrants: [],
      });
    } finally {
      await located.release();
    }
  }
  const catalog = { snapshot: async () => ({ entries: [entry], status: 'fresh', checkedAt: 10_000 }) };
  const assets = new PluginManagerPackageAssetService({
    inventory: store,
    packages: locator,
    packagesRoot: root,
    catalog,
    fetchArchive: async () => archive.bytes,
    validateManifest: metadataContractRuntime().validateManifest,
  });
  return { archive, assets, entry, packageManifest, root };
}

describe('F202 Plugin Manager package assets', () => {
  it('serves an installed verified SVG through a bounded same-origin asset response', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8H0z"/></svg>');
    const { assets, packageManifest } = await fixture({
      icon: { type: 'svg', src: 'assets/icon.svg' },
      iconBytes: svg,
    });

    const asset = await assets.readIcon(packageManifest.pluginId);

    assert.equal(asset.contentType, 'image/svg+xml');
    assert.deepEqual(asset.bytes, svg);
    assert.match(asset.etag, /^"[a-f0-9]{64}"$/);
  });

  it('reads a catalog icon ephemerally without publishing or installing the package', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0x00, 0x00, 0x00, 0x0d]),
      Buffer.from('IHDR'),
      Buffer.alloc(13),
    ]);
    const { assets, packageManifest, root } = await fixture({
      icon: { type: 'png', src: 'assets/icon.png' },
      iconBytes: png,
      catalogOnly: true,
    });

    const asset = await assets.readIcon(packageManifest.pluginId);

    assert.equal(asset.contentType, 'image/png');
    assert.deepEqual(asset.bytes, png);
    assert.deepEqual(await readdir(root), [], 'catalog discovery must leave no installed or staged package behind');
  });

  it('reads package-root README only on explicit detail demand', async () => {
    const readme = '# Video Analysis\n\nDetailed human-facing usage and privacy notes.';
    const { assets, packageManifest } = await fixture({
      icon: { type: 'svg', src: 'assets/icon.svg' },
      iconBytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      readme,
      catalogOnly: true,
    });

    assert.equal(await assets.readReadme(packageManifest.pluginId), readme);
  });

  it('fails closed when declared PNG bytes do not match their media type', async () => {
    const { assets, packageManifest } = await fixture({
      icon: { type: 'png', src: 'assets/icon.png' },
      iconBytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    });

    await assert.rejects(
      () => assets.readIcon(packageManifest.pluginId),
      (error) => error instanceof PluginManagerPackageAssetError && error.code === 'INVALID_ASSET',
    );
  });
});
