import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  FilePluginPackageQuarantineStore,
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

test('installs a package built against the exact consumed prerelease contract', async () => {
  const packageManifest = manifest({ contractVersion: '0.1.0-beta.13' });
  const archive = await packageArchive({ packageManifest });
  const entry = catalogEntry(archive.integrity);
  const { store, installer } = await harness(archive, entry);

  await installer.install(entry.catalogId, releaseFence(entry));

  assert.equal((await store.snapshot()).packages[0].contractVersion, '0.1.0-beta.13');
});

test('quarantines a catalog package rejected by the Host contract allowlist', async () => {
  const packageManifest = manifest({ contractVersion: '0.1.0-beta.14' });
  const archive = await packageArchive({ packageManifest });
  const entry = catalogEntry(archive.integrity);
  const { packagesRoot, inventory, store } = await harness(archive, entry);
  const quarantines = new FilePluginPackageQuarantineStore(join(packagesRoot, 'quarantines.json'), {
    now: () => 10_000,
  });
  const installer = new OfficialPluginPackageInstaller({
    inventory,
    packagesRoot,
    catalog: [entry],
    fetchArchive: async () => archive.bytes,
    quarantine: quarantines,
  });

  await assert.rejects(installer.install(entry.catalogId, releaseFence(entry)), isInstallError('INVENTORY_REJECTED'));

  assert.equal((await store.snapshot()).instances.length, 0);
  const [rejected] = await quarantines.list();
  assert.equal(rejected.pluginId, entry.pluginId);
  assert.equal(rejected.packageDigest, archive.integrity);
  assert.equal(rejected.failure.code, 'CONTRACT_VERSION_MISMATCH');
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

test('explicit update replaces a stopped older package in place and preserves its stable activation state', async () => {
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
  assert.equal(snapshot.instances[0].activationState, 'error');
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
]) {
  test(`rejects catalog drift in ${label} without inventory mutation`, async () => {
    const archive = await packageArchive({ packageManifest });
    const entry = catalogEntry(archive.integrity);
    const { store, installer } = await harness(archive, entry);

    await assert.rejects(installer.install('feishu-meeting-intake', releaseFence(entry)), isInstallError(expectedCode));
    assert.equal((await store.snapshot()).instances.length, 0);
  });
}

test('rejects a catalog/package presentation split before publishing or mutating inventory', async () => {
  const archive = await packageArchive();
  const entry = catalogEntry(archive.integrity, {
    presentation: {
      displayName: 'Different catalog name',
      description: 'Different catalog description',
      icon: 'blocks',
      publisher: 'Clowder AI',
    },
  });
  const { packagesRoot, store, inventory } = await harness(archive, entry);
  const quarantines = new FilePluginPackageQuarantineStore(join(packagesRoot, 'quarantines.json'), {
    now: () => 10_000,
  });
  const installer = new OfficialPluginPackageInstaller({
    inventory,
    packagesRoot,
    catalog: [entry],
    fetchArchive: async () => archive.bytes,
    quarantine: quarantines,
  });

  await assert.rejects(
    installer.install('feishu-meeting-intake', releaseFence(entry)),
    isInstallError('PACKAGE_PRESENTATION_MISMATCH'),
  );
  assert.equal((await store.snapshot()).instances.length, 0);
  await assert.rejects(access(join(packagesRoot, packageDirectoryName(entry.packageDigest), 'package.tgz')));
  assert.deepEqual(
    (await quarantines.list()).map((record) => record.failure.code),
    ['PACKAGE_PRESENTATION_MISMATCH'],
  );
});

test('admits a contract-valid builtin package without reinterpreting it as an external stdio runtime', async () => {
  const archive = await packageArchive({ packageManifest: manifest({ runtime: { transport: 'builtin' } }) });
  const entry = catalogEntry(archive.integrity);
  const { store, installer } = await harness(archive, entry);

  const installed = await installer.install('feishu-meeting-intake', releaseFence(entry));

  assert.equal(installed.pluginInstanceId, 'pi_official');
  const snapshot = await store.snapshot();
  assert.equal(snapshot.packages[0].manifest.runtime.transport, 'builtin');
  assert.equal(snapshot.instances[0].activationState, 'disabled');
  assert.equal(snapshot.instances[0].runtimeState, 'stopped');
});

test('rejects an unsupported ipc runtime before publishing or mutating inventory', async () => {
  const archive = await packageArchive({
    packageManifest: manifest({ runtime: { transport: 'ipc', entrypoint: 'dist/entrypoint.js' } }),
  });
  const entry = catalogEntry(archive.integrity);
  const { packagesRoot, store, installer } = await harness(archive, entry);

  await assert.rejects(
    installer.install('feishu-meeting-intake', releaseFence(entry)),
    isInstallError('UNSUPPORTED_TRANSPORT'),
  );

  assert.equal((await store.snapshot()).instances.length, 0);
  await assert.rejects(access(join(packagesRoot, packageDirectoryName(entry.packageDigest), 'package.tgz')));
});

test('admits the canonical plugin.yaml shipped by an npm package', async () => {
  const archive = await packageArchive({ manifestFilename: 'plugin.yaml' });
  const entry = catalogEntry(archive.integrity);
  const { store, installer } = await harness(archive, entry);

  await installer.install('feishu-meeting-intake', releaseFence(entry));

  assert.equal((await store.snapshot()).packages[0].manifest.pluginId, 'official.test-source');
});

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
