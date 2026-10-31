// Explicit network smoke, run by the Windows lane rather than the unit suite.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
  OfficialPluginPackageInstaller,
} from '../dist/domains/plugin/index.js';
import { OFFICIAL_PLUGIN_CATALOG } from '../dist/domains/plugin/official-catalog.js';
import { downloadCatalogArchive } from '../dist/domains/plugin/official-package-archive.js';

test(
  'installs the exact published Companion archive with real tar and Host admission',
  { timeout: 90_000 },
  async () => {
    const entry = OFFICIAL_PLUGIN_CATALOG.find((candidate) => candidate.catalogId === 'companion');
    assert.ok(entry);
    const packagesRoot = await mkdtemp(join(tmpdir(), 'companion-registry-'));
    try {
      const bytes = await downloadCatalogArchive(entry);
      const store = new MemoryPluginInventoryStore();
      const inventory = new HostInventoryControlPlane(store);
      const installer = new OfficialPluginPackageInstaller({
        inventory,
        packagesRoot,
        catalog: [entry],
        fetchArchive: async () => bytes,
      });
      const result = await installer.install(entry.catalogId, {
        version: entry.version,
        packageDigest: entry.packageDigest,
      });
      assert.equal(result.packageDigest, entry.packageDigest);
      const snapshot = await store.snapshot();
      assert.equal(snapshot.instances.length, 1);
      assert.equal(snapshot.instances[0].pluginId, entry.pluginId);
      assert.equal(snapshot.packages[0].manifest.version, entry.version);
      assert.equal(snapshot.instances[0].runtimeState, 'stopped');
      assert.equal(
        (await readdir(packagesRoot)).some(
          (name) => name.startsWith('.admission-') || name.startsWith('.runtime-stage-'),
        ),
        false,
      );
    } finally {
      await rm(packagesRoot, { recursive: true, force: true });
    }
  },
);
