import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
  OfficialPluginPackageInstaller,
  packageDirectoryName,
} from '../dist/domains/plugin/index.js';
import {
  catalogEntry,
  harness,
  isInstallError,
  manifest,
  packageArchive,
  releaseFence,
} from './plugin-official-package-installer.fixture.js';

test('installs only the exact catalog artifact and admits schemas from those bytes', async () => {
  const archive = await packageArchive();
  const { packagesRoot, store, installer } = await harness(archive);

  const installed = await installer.install('feishu-meeting-intake', releaseFence(catalogEntry(archive.integrity)));

  assert.deepEqual(installed, {
    pluginInstanceId: 'pi_official',
    packageDigest: archive.integrity,
    grantRevision: 1,
  });
  const snapshot = await store.snapshot();
  assert.equal(snapshot.packages.length, 1);
  assert.equal(snapshot.packages[0].manifest.runtime.transport, 'stdio');
  assert.deepEqual(Object.keys(snapshot.packages[0].signalSchemas), ['schemas/official.test.v1.schema.json']);
  assert.deepEqual(snapshot.instances[0], {
    pluginInstanceId: 'pi_official',
    pluginId: 'official.test-source',
    packageDigest: archive.integrity,
    lifecycleState: 'installed',
    configReadiness: 'incomplete',
    activationState: 'disabled',
    runtimeState: 'stopped',
    lifecycleRevision: 1,
    installedAt: 10_000,
    updatedAt: 10_000,
  });
  await access(join(packagesRoot, packageDirectoryName(archive.integrity), 'package.tgz'));
});

test('same exact catalog install is idempotent and does not mint a second instance', async () => {
  const archive = await packageArchive();
  const { store, installer } = await harness(archive);

  const expectedRelease = releaseFence(catalogEntry(archive.integrity));
  const first = await installer.install('feishu-meeting-intake', expectedRelease);
  const second = await installer.install('feishu-meeting-intake', expectedRelease);

  assert.deepEqual(second, first);
  assert.equal((await store.snapshot()).instances.length, 1);
});

test('explicit update replaces a stopped older package in place and remains disabled', async () => {
  const oldArchive = await packageArchive();
  const nextManifest = manifest({ version: '0.1.0-alpha.2' });
  const nextArchive = await packageArchive({ packageManifest: nextManifest });
  const packagesRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-f292-official-cache-'));
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, {
    createInstanceId: () => 'pi_official',
    now: () => 10_000,
  });
  const oldInstaller = new OfficialPluginPackageInstaller({
    inventory,
    packagesRoot,
    catalog: [catalogEntry(oldArchive.integrity)],
    fetchArchive: async () => oldArchive.bytes,
  });
  await oldInstaller.install('feishu-meeting-intake', releaseFence(catalogEntry(oldArchive.integrity)));
  await store.transaction((transaction) => {
    const current = transaction.instances.get('pi_official');
    transaction.instances.put({
      ...current,
      configReadiness: 'ready',
      activationState: 'error',
      runtimeState: 'stopped',
    });
  });
  const nextEntry = catalogEntry(nextArchive.integrity, {
    version: nextManifest.version,
    archiveUrl: 'https://registry.npmjs.org/@clowder-ai/official-test-source/-/official-test-source-0.1.0-alpha.2.tgz',
  });
  const installer = new OfficialPluginPackageInstaller({
    inventory,
    packagesRoot,
    catalog: [nextEntry],
    fetchArchive: async () => nextArchive.bytes,
  });

  const updated = await installer.update('feishu-meeting-intake', 'pi_official', 1, {
    version: nextEntry.version,
    packageDigest: nextEntry.packageDigest,
  });

  assert.deepEqual(updated, {
    pluginInstanceId: 'pi_official',
    packageDigest: nextArchive.integrity,
    grantRevision: 2,
  });
  const snapshot = await store.snapshot();
  assert.equal(snapshot.instances.filter((instance) => instance.lifecycleState === 'installed').length, 1);
  assert.equal(snapshot.instances[0].packageDigest, nextArchive.integrity);
  assert.equal(snapshot.instances[0].configReadiness, 'ready');
  assert.equal(snapshot.instances[0].activationState, 'disabled');
  assert.equal(snapshot.instances[0].runtimeState, 'stopped');
  assert.equal(snapshot.instances[0].lifecycleRevision, 2);
  assert.equal(
    snapshot.packages.find((item) => item.packageDigest === nextArchive.integrity)?.version,
    '0.1.0-alpha.2',
  );
});

test('explicit update rejects stale or running instances before downloading the archive', async () => {
  const oldArchive = await packageArchive();
  const nextManifest = manifest({ version: '0.1.0-alpha.2' });
  const nextArchive = await packageArchive({ packageManifest: nextManifest });
  const { packagesRoot, store, inventory, installer: oldInstaller } = await harness(oldArchive);
  await oldInstaller.install('feishu-meeting-intake', releaseFence(catalogEntry(oldArchive.integrity)));
  let fetches = 0;
  const installer = new OfficialPluginPackageInstaller({
    inventory,
    packagesRoot,
    catalog: [catalogEntry(nextArchive.integrity, { version: nextManifest.version })],
    fetchArchive: async () => {
      fetches += 1;
      return nextArchive.bytes;
    },
  });

  const expectedRelease = { version: nextManifest.version, packageDigest: nextArchive.integrity };
  await assert.rejects(
    installer.update('feishu-meeting-intake', 'pi_official', 2, expectedRelease),
    isInstallError('STALE_REVISION'),
  );
  await store.transaction((transaction) => {
    const current = transaction.instances.get('pi_official');
    transaction.instances.put({ ...current, activationState: 'enabled', runtimeState: 'healthy' });
  });
  await assert.rejects(
    installer.update('feishu-meeting-intake', 'pi_official', 1, expectedRelease),
    isInstallError('UPDATE_REQUIRES_STOPPED'),
  );
  assert.equal(fetches, 0);
});

test('digest mismatch fails before an archive or inventory mutation is published', async () => {
  const archive = await packageArchive();
  const wrongDigest = `sha512-${createHash('sha512').update('different').digest('base64')}`;
  const { packagesRoot, store, installer } = await harness(archive, catalogEntry(wrongDigest));

  await assert.rejects(
    installer.install('feishu-meeting-intake', releaseFence(catalogEntry(wrongDigest))),
    isInstallError('PACKAGE_DIGEST_MISMATCH'),
  );
  assert.equal((await store.snapshot()).instances.length, 0);
  await assert.rejects(access(join(packagesRoot, packageDirectoryName(wrongDigest), 'package.tgz')));
});

for (const [label, packageManifest, expectedCode] of [
  ['plugin identity', manifest({ pluginId: 'official.other-source' }), 'PACKAGE_ID_MISMATCH'],
  ['version', manifest({ version: '0.1.0-alpha.2' }), 'PACKAGE_VERSION_MISMATCH'],
  ['transport', manifest({ runtime: { transport: 'builtin' } }), 'UNSUPPORTED_TRANSPORT'],
]) {
  test(`rejects catalog drift in ${label} without inventory mutation`, async () => {
    const archive = await packageArchive({ packageManifest });
    const entry = catalogEntry(archive.integrity);
    const { store, installer } = await harness(archive, entry);

    await assert.rejects(installer.install('feishu-meeting-intake', releaseFence(entry)), isInstallError(expectedCode));
    assert.equal((await store.snapshot()).instances.length, 0);
  });
}

test('missing package-local declared schema fails closed with no inventory mutation', async () => {
  const archive = await packageArchive({ includeSchema: false });
  const { store, installer } = await harness(archive);

  await assert.rejects(
    installer.install('feishu-meeting-intake', releaseFence(catalogEntry(archive.integrity))),
    isInstallError('INVALID_PACKAGE_SCHEMA'),
  );
  assert.equal((await store.snapshot()).instances.length, 0);
});

test('unknown catalog identifiers never reach the archive fetcher', async () => {
  const archive = await packageArchive();
  let fetches = 0;
  const { packagesRoot, inventory } = await harness(archive);
  const installer = new OfficialPluginPackageInstaller({
    inventory,
    packagesRoot,
    catalog: [catalogEntry(archive.integrity)],
    fetchArchive: async () => {
      fetches += 1;
      return archive.bytes;
    },
  });

  await assert.rejects(
    installer.install('https://attacker.invalid/package.tgz', releaseFence(catalogEntry(archive.integrity))),
    isInstallError('UNKNOWN_CATALOG_ID'),
  );
  assert.equal(fetches, 0);
});
