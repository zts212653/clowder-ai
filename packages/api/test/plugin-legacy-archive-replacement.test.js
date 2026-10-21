import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ExternalPluginLifecycleService,
  HostInventoryControlPlane,
  LocalPluginPackageAdmission,
  MemoryPluginInventoryStore,
} from '../dist/domains/plugin/index.js';
import { manifest, packageArchive } from './plugin-official-package-installer.fixture.js';

test('a verified archive offers exact legacy replacement before changing the installed instance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-archive-replacement-'));
  try {
    const oldManifest = manifest({ version: '0.1.0', signals: undefined });
    const oldArchive = await packageArchive({ packageManifest: oldManifest });
    const nextManifest = manifest({ version: '0.2.0', signals: undefined });
    const nextArchive = await packageArchive({ packageManifest: nextManifest });
    const store = new MemoryPluginInventoryStore();
    const inventory = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_original' });
    await inventory.installPackage({
      manifest: oldManifest,
      packagePluginId: oldManifest.pluginId,
      computedPackageDigest: oldArchive.integrity,
      expectedPackageDigest: oldArchive.integrity,
      effectiveGrants: [],
      signalSchemas: {},
    });
    const before = await store.snapshot();
    const archivePath = join(root, 'next.tgz');
    await writeFile(archivePath, nextArchive.bytes);
    const admission = new LocalPluginPackageAdmission({
      inventory,
      packagesRoot: join(root, 'packages'),
      grantPolicy: () => [],
    });
    await assert.rejects(admission.install({ kind: 'local-archive', path: archivePath }), (error) => {
      assert.equal(error.code, 'ARCHIVE_REPLACEMENT_CONFIRMATION_REQUIRED');
      assert.deepEqual(error.replacement.confirmation, {
        pluginId: oldManifest.pluginId,
        pluginInstanceId: 'pi_original',
        currentPackageDigest: oldArchive.integrity,
        candidatePackageDigest: nextArchive.integrity,
        expectedLifecycleRevision: before.instances[0].lifecycleRevision,
        expectedGrantRevision: before.grants[0].grantRevision,
        candidateEffectiveGrants: [],
      });
      return true;
    });
    assert.deepEqual(await store.snapshot(), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(t, { provenance, grantPolicy = () => [], reconcileConfiguration } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'legacy-archive-replacement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldManifest = manifest({ version: '0.1.0', signals: undefined });
  const oldArchive = await packageArchive({ packageManifest: oldManifest });
  const nextManifest = manifest({ version: '0.2.0', signals: undefined });
  const nextArchive = await packageArchive({ packageManifest: nextManifest });
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_original' });
  await inventory.installPackage({
    manifest: oldManifest,
    packagePluginId: oldManifest.pluginId,
    computedPackageDigest: oldArchive.integrity,
    expectedPackageDigest: oldArchive.integrity,
    effectiveGrants: [],
    signalSchemas: {},
    ...(provenance ? { provenance } : {}),
  });
  const path = join(root, 'next.tgz');
  await writeFile(path, nextArchive.bytes);
  const lifecycleCalls = [];
  const lifecycle = new ExternalPluginLifecycleService({
    store,
    supervisor: {
      stop: async (id) => lifecycleCalls.push(['stop', id]),
      start: async (id) => lifecycleCalls.push(['start', id]),
    },
  });
  const admission = new LocalPluginPackageAdmission({
    inventory,
    packagesRoot: join(root, 'packages'),
    grantPolicy,
    lifecycle,
    reconcileConfiguration,
  });
  const source = { kind: 'local-archive', path };
  return {
    store,
    inventory,
    admission,
    source,
    lifecycleCalls,
    oldArchive,
    nextArchive,
    async offer() {
      let confirmation;
      await assert.rejects(admission.install(source), (error) => {
        assert.equal(error.code, 'ARCHIVE_REPLACEMENT_CONFIRMATION_REQUIRED');
        confirmation = error.replacement.confirmation;
        return true;
      });
      return confirmation;
    },
  };
}

test('an invalid Host grant decision is rejected before offering legacy replacement', async (t) => {
  const h = await fixture(t, { grantPolicy: () => ['unknown.capability'] });
  const before = await h.store.snapshot();
  await assert.rejects(h.admission.install(h.source), (error) => {
    assert.equal(error.code, 'INVENTORY_REJECTED');
    assert.equal(error.cause.code, 'INVALID_GRANT');
    return true;
  });
  assert.deepEqual(await h.store.snapshot(), before);
  assert.deepEqual(h.lifecycleCalls, []);
});

test('a changed Host policy requires a new confirmation even when the instance is unchanged', async (t) => {
  let grants = [];
  const h = await fixture(t, { grantPolicy: () => grants });
  const replacement = await h.offer();
  const before = await h.store.snapshot();
  grants = ['messaging.send'];
  await assert.rejects(h.admission.install(h.source, { replacement }), { code: 'STALE_ARCHIVE_REPLACEMENT' });
  assert.deepEqual(await h.store.snapshot(), before);
  assert.deepEqual(h.lifecycleCalls, []);
});

test('confirmation cannot add a capability outside the Host policy', async (t) => {
  const h = await fixture(t);
  const replacement = await h.offer();
  replacement.candidateEffectiveGrants.push('messaging.send');
  const before = await h.store.snapshot();
  await assert.rejects(h.admission.install(h.source, { replacement }), { code: 'STALE_ARCHIVE_REPLACEMENT' });
  assert.deepEqual(await h.store.snapshot(), before);
  assert.deepEqual(h.lifecycleCalls, []);
});

for (const enabled of [false, true]) {
  test(`confirmed legacy archive preserves the instance and activation intent (enabled=${enabled})`, async (t) => {
    const reconciled = [];
    const h = await fixture(t, {
      grantPolicy: () => ['messaging.send'],
      reconcileConfiguration: async (...args) => reconciled.push(args),
    });
    if (enabled)
      await h.store.transaction((tx) =>
        tx.instances.put({
          ...tx.instances.get('pi_original'),
          activationState: 'enabled',
          runtimeState: 'healthy',
          configReadiness: 'ready',
        }),
      );
    const before = await h.store.snapshot();
    const replacement = await h.offer();
    assert.deepEqual(await h.store.snapshot(), before);
    assert.deepEqual(h.lifecycleCalls, []);
    const result = await h.admission.install(h.source, { replacement });
    assert.equal(result.pluginInstanceId, 'pi_original');
    const after = await h.store.snapshot();
    assert.equal(after.instances.length, 1);
    assert.equal(after.instances[0].installedAt, before.instances[0].installedAt);
    assert.equal(after.instances[0].packageDigest, h.nextArchive.integrity);
    assert.equal(after.instances[0].activationState, enabled ? 'enabled' : 'disabled');
    assert.ok(after.packages.some((record) => record.packageDigest === h.oldArchive.integrity));
    assert.deepEqual(after.grants[0].effectiveGrants, ['messaging.send']);
    assert.deepEqual(reconciled, [['official.test-source', 'pi_original']]);
    assert.deepEqual(
      h.lifecycleCalls,
      enabled
        ? [
            ['stop', 'pi_original'],
            ['start', 'pi_original'],
          ]
        : [],
    );
    await assert.rejects(h.admission.install(h.source, { replacement }), { code: 'STALE_ARCHIVE_REPLACEMENT' });
    assert.deepEqual(await h.store.snapshot(), after);
  });
}

for (const field of [
  'pluginId',
  'pluginInstanceId',
  'currentPackageDigest',
  'candidatePackageDigest',
  'expectedLifecycleRevision',
  'expectedGrantRevision',
]) {
  test(`rejects a changed ${field} before touching lifecycle or inventory`, async (t) => {
    const h = await fixture(t);
    const replacement = await h.offer();
    const before = await h.store.snapshot();
    replacement[field] =
      typeof replacement[field] === 'number' ? replacement[field] + 1 : `${replacement[field]}-changed`;
    await assert.rejects(h.admission.install(h.source, { replacement }), { code: 'STALE_ARCHIVE_REPLACEMENT' });
    assert.deepEqual(await h.store.snapshot(), before);
    assert.deepEqual(h.lifecycleCalls, []);
  });
}

test('changed archive bytes cannot consume an earlier confirmation', async (t) => {
  const h = await fixture(t);
  const replacement = await h.offer();
  const before = await h.store.snapshot();
  const changed = await packageArchive({ packageManifest: manifest({ version: '0.3.0', signals: undefined }) });
  await writeFile(h.source.path, changed.bytes);
  await assert.rejects(h.admission.install(h.source, { replacement }), { code: 'STALE_ARCHIVE_REPLACEMENT' });
  assert.deepEqual(await h.store.snapshot(), before);
  assert.deepEqual(h.lifecycleCalls, []);
});

for (const recordKind of ['instances', 'grants']) {
  test(`an intervening owner ${recordKind} mutation invalidates the offer`, async (t) => {
    const h = await fixture(t);
    const replacement = await h.offer();
    await h.store.transaction((tx) => {
      const record = tx[recordKind].get('pi_original');
      const key = recordKind === 'instances' ? 'lifecycleRevision' : 'grantRevision';
      tx[recordKind].put({ ...record, [key]: record[key] + 1 });
    });
    const before = await h.store.snapshot();
    await assert.rejects(h.admission.install(h.source, { replacement }), { code: 'STALE_ARCHIVE_REPLACEMENT' });
    assert.deepEqual(await h.store.snapshot(), before);
    assert.deepEqual(h.lifecycleCalls, []);
  });
}

for (const kind of ['local-directory', 'catalog', 'git']) {
  test(`legacy confirmation does not allow switching the known ${kind} source`, async (t) => {
    const h = await fixture(t, {
      provenance: {
        kind,
        packageName: '@clowder-ai/official-test-source',
        ...(kind === 'catalog' ? { catalogId: 'test' } : {}),
        ...(kind === 'git' ? { url: 'https://example.test/plugin.git' } : {}),
      },
    });
    const before = await h.store.snapshot();
    await assert.rejects(h.admission.install(h.source), { code: 'INVENTORY_REJECTED' });
    assert.deepEqual(await h.store.snapshot(), before);
    assert.deepEqual(h.lifecycleCalls, []);
  });
}

test('configuration failure restores the legacy package and preserves instance history', async (t) => {
  const h = await fixture(t, {
    reconcileConfiguration: async () => {
      throw new Error('configuration failed');
    },
  });
  const before = await h.store.snapshot();
  const replacement = await h.offer();
  await assert.rejects(h.admission.install(h.source, { replacement }), /configuration failed/);
  const after = await h.store.snapshot();
  assert.equal(after.instances[0].pluginInstanceId, before.instances[0].pluginInstanceId);
  assert.equal(after.instances[0].packageDigest, before.instances[0].packageDigest);
  assert.equal(after.instances[0].installedAt, before.instances[0].installedAt);
  assert.deepEqual(after.grants[0].effectiveGrants, before.grants[0].effectiveGrants);
  assert.ok(after.instances[0].lifecycleRevision > before.instances[0].lifecycleRevision);
});
