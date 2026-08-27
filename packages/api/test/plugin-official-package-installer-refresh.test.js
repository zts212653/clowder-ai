import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
  OfficialPluginPackageInstaller,
} from '../dist/domains/plugin/index.js';
import {
  catalogEntry,
  isInstallError,
  manifest,
  packageArchive,
  releaseFence,
} from './plugin-official-package-installer.fixture.js';

test('explicit install rejects when the provider advances past the owner-confirmed release', async () => {
  const alpha5Manifest = manifest({ version: '0.1.0-alpha.5' });
  const alpha5Archive = await packageArchive({ packageManifest: alpha5Manifest });
  const alpha4 = catalogEntry(`sha512-${Buffer.alloc(64, 4).toString('base64')}`, {
    version: '0.1.0-alpha.4',
    archiveUrl: 'https://registry.npmjs.org/@clowder-ai/official-test-source/-/official-test-source-0.1.0-alpha.4.tgz',
  });
  const alpha5 = catalogEntry(alpha5Archive.integrity, {
    version: alpha5Manifest.version,
    archiveUrl: 'https://registry.npmjs.org/@clowder-ai/official-test-source/-/official-test-source-0.1.0-alpha.5.tgz',
  });
  let fetches = 0;
  const packagesRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-f292-official-cache-'));
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, {
    createInstanceId: () => 'pi_official',
    now: () => 10_000,
  });
  const installer = new OfficialPluginPackageInstaller({
    inventory,
    packagesRoot,
    catalog: [alpha4],
    catalogProvider: {
      snapshot: async () => ({ entries: [alpha5], status: 'fresh', checkedAt: 1_000 }),
    },
    fetchArchive: async () => {
      fetches += 1;
      return alpha5Archive.bytes;
    },
  });

  await assert.rejects(
    installer.install(alpha4.catalogId, {
      version: alpha4.version,
      packageDigest: alpha4.packageDigest,
    }),
    isInstallError('STALE_CATALOG'),
  );
  assert.equal(fetches, 0);
  assert.equal((await store.snapshot()).instances.length, 0);
});

test('one installer observes a newer provider snapshot and preserves a stopped error projection', async () => {
  const alpha4Manifest = manifest({ version: '0.1.0-alpha.4' });
  const alpha5Manifest = manifest({ version: '0.1.0-alpha.5' });
  const alpha4Archive = await packageArchive({ packageManifest: alpha4Manifest });
  const alpha5Archive = await packageArchive({ packageManifest: alpha5Manifest });
  const alpha4 = catalogEntry(alpha4Archive.integrity, {
    version: alpha4Manifest.version,
    archiveUrl: 'https://registry.npmjs.org/@clowder-ai/official-test-source/-/official-test-source-0.1.0-alpha.4.tgz',
  });
  const alpha5 = catalogEntry(alpha5Archive.integrity, {
    version: alpha5Manifest.version,
    archiveUrl: 'https://registry.npmjs.org/@clowder-ai/official-test-source/-/official-test-source-0.1.0-alpha.5.tgz',
  });
  let current = alpha4;
  const packagesRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-f292-official-cache-'));
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, {
    createInstanceId: () => 'pi_official',
    now: () => 10_000,
  });
  const installer = new OfficialPluginPackageInstaller({
    inventory,
    packagesRoot,
    catalog: [alpha4],
    catalogProvider: {
      snapshot: async () => ({ entries: [current], status: 'fresh', checkedAt: 1_000 }),
    },
    fetchArchive: async (entry) => (entry.version === alpha4.version ? alpha4Archive.bytes : alpha5Archive.bytes),
  });

  await installer.install(alpha4.catalogId, releaseFence(alpha4));
  await store.transaction((transaction) => {
    const instance = transaction.instances.get('pi_official');
    transaction.instances.put({
      ...instance,
      configReadiness: 'ready',
      activationState: 'error',
      runtimeState: 'stopped',
    });
  });
  current = alpha5;

  await assert.rejects(
    installer.update(alpha5.catalogId, 'pi_official', 1, {
      version: alpha4.version,
      packageDigest: alpha4.packageDigest,
    }),
    isInstallError('STALE_CATALOG'),
  );
  const updated = await installer.update(alpha5.catalogId, 'pi_official', 1, {
    version: alpha5.version,
    packageDigest: alpha5.packageDigest,
  });
  assert.equal(updated.packageDigest, alpha5.packageDigest);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.instances[0].packageDigest, alpha5.packageDigest);
  assert.equal(snapshot.instances[0].activationState, 'error');
  assert.equal(snapshot.instances[0].runtimeState, 'stopped');
});

test('an older catalog snapshot cannot downgrade a newer installed package or reach archive download', async () => {
  const alpha5Manifest = manifest({ version: '0.1.0-alpha.5' });
  const alpha5Archive = await packageArchive({ packageManifest: alpha5Manifest });
  const alpha5 = catalogEntry(alpha5Archive.integrity, {
    version: alpha5Manifest.version,
    archiveUrl: 'https://registry.npmjs.org/@clowder-ai/official-test-source/-/official-test-source-0.1.0-alpha.5.tgz',
  });
  const alpha4 = catalogEntry(`sha512-${Buffer.alloc(64, 4).toString('base64')}`, {
    version: '0.1.0-alpha.4',
    archiveUrl: 'https://registry.npmjs.org/@clowder-ai/official-test-source/-/official-test-source-0.1.0-alpha.4.tgz',
  });
  let current = alpha5;
  let fetches = 0;
  const packagesRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-f292-official-cache-'));
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, {
    createInstanceId: () => 'pi_official',
    now: () => 10_000,
  });
  const installer = new OfficialPluginPackageInstaller({
    inventory,
    packagesRoot,
    catalog: [alpha5],
    catalogProvider: {
      snapshot: async () => ({ entries: [current], status: 'fresh', checkedAt: 1_000 }),
    },
    fetchArchive: async () => {
      fetches += 1;
      return alpha5Archive.bytes;
    },
  });
  await installer.install(alpha5.catalogId, releaseFence(alpha5));
  assert.equal(fetches, 1);
  current = alpha4;

  await assert.rejects(
    installer.update(alpha4.catalogId, 'pi_official', 1, {
      version: alpha4.version,
      packageDigest: alpha4.packageDigest,
    }),
    isInstallError('UPDATE_NOT_NEWER'),
  );
  assert.equal(fetches, 1);
  assert.equal((await store.snapshot()).instances[0].packageDigest, alpha5.packageDigest);
});

test('a restarted installer rejects install and update when a newer version reuses the installed digest', async () => {
  const alpha5Manifest = manifest({ version: '0.1.0-alpha.5' });
  const alpha5Archive = await packageArchive({ packageManifest: alpha5Manifest });
  const alpha5 = catalogEntry(alpha5Archive.integrity, {
    version: alpha5Manifest.version,
    archiveUrl: 'https://registry.npmjs.org/@clowder-ai/official-test-source/-/official-test-source-0.1.0-alpha.5.tgz',
  });
  const alpha6 = catalogEntry(alpha5Archive.integrity, {
    version: '0.1.0-alpha.6',
    archiveUrl: 'https://registry.npmjs.org/@clowder-ai/official-test-source/-/official-test-source-0.1.0-alpha.6.tgz',
  });
  let current = alpha5;
  let fetches = 0;
  const packagesRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-f292-official-cache-'));
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, {
    createInstanceId: () => 'pi_official',
    now: () => 10_000,
  });
  const installer = new OfficialPluginPackageInstaller({
    inventory,
    packagesRoot,
    catalogProvider: {
      snapshot: async () => ({ entries: [current], status: 'fresh', checkedAt: 1_000 }),
    },
    fetchArchive: async () => {
      fetches += 1;
      return alpha5Archive.bytes;
    },
  });

  await installer.install(alpha5.catalogId, releaseFence(alpha5));
  current = alpha6;

  await assert.rejects(
    installer.install(alpha6.catalogId, releaseFence(alpha6)),
    isInstallError('PACKAGE_VERSION_MISMATCH'),
  );
  await assert.rejects(
    installer.update(alpha6.catalogId, 'pi_official', 1, releaseFence(alpha6)),
    isInstallError('PACKAGE_VERSION_MISMATCH'),
  );
  assert.equal(fetches, 1);
  assert.equal((await store.snapshot()).packages[0].version, alpha5.version);
});
