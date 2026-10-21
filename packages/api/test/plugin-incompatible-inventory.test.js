import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FilePluginInventoryStore, HostInventoryControlPlane } from '../dist/domains/plugin/host-inventory/index.js';
import { parsePluginInventorySnapshot } from '../dist/domains/plugin/host-inventory/snapshot.js';

const digest = (text) => `sha512-${createHash('sha512').update(text).digest('base64')}`;
// Published @clowder-ai/feishu-meeting-intake@0.1.0-alpha.9 manifest.
const oldManifest = {
  pluginId: 'official.feishu-meeting-intake',
  version: '0.1.0-alpha.9',
  contractVersion: '0.1.0',
  name: 'Feishu Meeting Intake',
  features: [
    {
      id: 'generated-meeting-artifacts',
      name: 'Generated meeting artifacts',
      resources: [
        {
          type: 'input-source',
          id: 'feishu.meeting_artifact.generated.v1',
        },
      ],
      capabilities: ['events.publish'],
    },
  ],
  signals: {
    provides: [
      {
        type: 'feishu.meeting_artifact.generated.v1',
        schemaRef: 'schemas/feishu-meeting-artifact.schema.json',
        epistemicStatus: 'observation',
        privacyClass: 'content-adjacent',
        sourceClass: 'remote-service',
      },
    ],
  },
  runtime: {
    transport: 'stdio',
    entrypoint: 'dist/entrypoint.js',
  },
};
function oldSnapshot() {
  return {
    schemaVersion: 1,
    packages: [
      {
        packageDigest: digest('old'),
        pluginId: oldManifest.pluginId,
        version: oldManifest.version,
        contractVersion: '0.1.0',
        manifest: oldManifest,
        signalSchemas: {},
        packageState: 'installed',
        verifiedAt: 1,
        updatedAt: 1,
      },
    ],
    instances: [
      {
        pluginInstanceId: 'old-instance',
        pluginId: oldManifest.pluginId,
        packageDigest: digest('old'),
        lifecycleState: 'installed',
        configReadiness: 'ready',
        activationState: 'enabled',
        runtimeState: 'stopped',
        lifecycleRevision: 1,
        installedAt: 1,
        updatedAt: 1,
      },
    ],
    grants: [
      {
        pluginInstanceId: 'old-instance',
        requestedCapabilities: ['events.publish'],
        effectiveGrants: ['events.publish'],
        grantRevision: 1,
        updatedAt: 1,
      },
    ],
  };
}
function replacement() {
  const { signals: _retiredSignals, ...current } = oldManifest;
  const manifest = {
    ...current,
    version: '0.1.0-alpha.11',
    features: [{ id: 'messages', name: 'Messages', resources: [], capabilities: ['messaging.send'] }],
  };
  return {
    manifest,
    packagePluginId: manifest.pluginId,
    computedPackageDigest: digest('new'),
    expectedPackageDigest: digest('new'),
    effectiveGrants: ['messaging.send'],
  };
}
test('incompatible old manifest remains durable but is not exposed as an executable manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-incompatible-'));
  const path = join(root, 'inventory.json');
  const original = oldSnapshot();
  await writeFile(path, JSON.stringify(original));
  const store = new FilePluginInventoryStore(path);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.packages[0].manifest, null);
  assert.deepEqual(snapshot.packages[0].incompatibleManifest, oldManifest);
  assert.deepEqual(snapshot.instances, original.instances);
  assert.deepEqual(snapshot.grants, original.grants);
  await store.transaction(() => {});
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), original);
});
test('invalid replacement leaves old authority intact; compatible upgrade replaces atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-incompatible-upgrade-'));
  const path = join(root, 'inventory.json');
  await writeFile(path, JSON.stringify(oldSnapshot()));
  const store = new FilePluginInventoryStore(path);
  const host = new HostInventoryControlPlane(store, { now: () => 5 });
  const fence = { pluginInstanceId: 'old-instance', expectedLifecycleRevision: 1, expectedGrantRevision: 1 };
  await assert.rejects(host.upgradePackage({ ...replacement(), manifest: oldManifest, ...fence }), {
    code: 'INVALID_MANIFEST',
  });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), oldSnapshot());
  await host.upgradePackage({ ...replacement(), ...fence });
  const s = await store.snapshot();
  assert.equal(s.instances[0].pluginInstanceId, 'old-instance');
  assert.equal(s.instances[0].packageDigest, digest('new'));
  assert.equal(s.packages.find((p) => p.packageDigest === digest('new')).manifest.version, '0.1.0-alpha.11');
  assert.deepEqual(s.grants[0].effectiveGrants, ['messaging.send']);
  assert.deepEqual(s.packages.find((p) => p.packageDigest === digest('old')).incompatibleManifest, oldManifest);
});
for (const [name, mutate] of [
  [
    'digest',
    (s) => {
      s.packages[0].packageDigest = 'bad';
    },
  ],
  [
    'identity',
    (s) => {
      s.packages[0].pluginId = 'different';
    },
  ],
  [
    'missing features',
    (s) => {
      s.packages[0].manifest = { ...oldManifest, features: null };
    },
  ],
  [
    'excess authority',
    (s) => {
      s.grants[0].effectiveGrants = ['unrequested'];
    },
  ],
])
  test(`incompatibility does not hide corrupt ${name}`, () => {
    const s = oldSnapshot();
    mutate(s);
    assert.throws(() => parsePluginInventorySnapshot(s), { code: 'CORRUPT_SNAPSHOT' });
  });

test('restart and Manager isolate old installs while a normal package remains usable', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  const { createDormantPluginRuntimeComposition, createPluginManagerRuntimeComposition } = await import(
    '../dist/domains/plugin/index.js'
  );
  const { reconcileOfficialPluginGrants } = await import('../dist/domains/plugin/manager/official-plugin-grants.js');
  const root = await mkdtemp(join(tmpdir(), 'plugin-incompatible-manager-'));
  const hostRoot = join(root, '.cat-cafe/plugin-host');
  await mkdir(hostRoot, { recursive: true });
  const original = oldSnapshot();
  await writeFile(join(hostRoot, 'inventory.json'), JSON.stringify(original));
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot: root,
    messageStore: new MessageStore(),
    now: () => 12000,
  });
  const good = replacement();
  good.manifest = { ...good.manifest, pluginId: 'official.normal' };
  good.packagePluginId = good.manifest.pluginId;
  good.provenance = { kind: 'local-archive' };
  const normal = await runtime.inventory.installPackage(good);
  assert.deepEqual(
    await reconcileOfficialPluginGrants({
      store: runtime.inventoryStore,
      inventory: runtime.inventory,
      hostPolicies: [{ pluginId: oldManifest.pluginId, effectiveGrants: ['messaging.send'] }],
    }),
    [],
  );
  assert.equal((await runtime.recoverAfterRestart()).resumeRequested, 0);
  const { manager } = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 12000 }) },
    catalogManifests: [],
    now: () => 12000,
  });
  const list = await manager.list();
  assert.equal(list.plugins.length, 2);
  const old = (await manager.get(oldManifest.pluginId)).plugin;
  assert.equal(old.pluginInstanceId, 'old-instance');
  assert.equal(old.diagnostic.code, 'PACKAGE_INCOMPATIBLE');
  assert.equal(old.actions.install, false);
  assert.equal(Object.hasOwn(old, 'installSources'), false);

  assert.equal(old.actions.setEnabled, false);
  assert.match(old.diagnostic.message, /当前无可用更新/);
  assert.deepEqual(old.capabilitySummary, []);
  await assert.rejects(
    manager.setEnabled(oldManifest.pluginId, { enabled: true, expectedRevision: old.lifecycleRevision }),
    { code: 'ACTION_NOT_ALLOWED' },
  );
  await assert.rejects(runtime.broker.openExternalConnection('old-instance'), { code: 'INSTANCE_NOT_READY' });
  await assert.rejects(runtime.supervisor.start('old-instance'), { code: 'INCOMPATIBLE_PACKAGE' });
  await assert.rejects(runtime.lifecycle.repair('old-instance', old.lifecycleRevision));
  await runtime.lifecycle.prepare(normal.pluginInstanceId, 1);
  assert.equal((await manager.get('official.normal')).plugin.config, 'ready');
  const snapshot = await runtime.inventoryStore.snapshot();
  assert.deepEqual(
    snapshot.grants.find((g) => g.pluginInstanceId === 'old-instance'),
    original.grants[0],
  );
  assert.deepEqual(snapshot.packages.find((p) => p.packageDigest === digest('old')).incompatibleManifest, oldManifest);
});

test('Manager strictly replaces an incompatible install from a compatible archive without losing data', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  const { createDormantPluginRuntimeComposition, createPluginManagerRuntimeComposition } = await import(
    '../dist/domains/plugin/index.js'
  );
  const { packageArchive, catalogEntry } = await import('./plugin-official-package-installer.fixture.js');
  const root = await mkdtemp(join(tmpdir(), 'plugin-incompatible-replace-'));
  const hostRoot = join(root, '.cat-cafe/plugin-host');
  await mkdir(hostRoot, { recursive: true });
  const legacy = oldSnapshot();
  legacy.packages[0].manifest = {
    ...oldManifest,
    runtime: { transport: 'builtin', entrypoint: 'dist/entrypoint.js', dataDirectory: 'meeting-data' },
  };
  await writeFile(join(hostRoot, 'inventory.json'), JSON.stringify(legacy));
  const dataDir = join(hostRoot, 'meeting-data');
  await mkdir(dataDir);
  await writeFile(join(dataDir, 'user-data.txt'), 'keep me');
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot: root,
    messageStore: new MessageStore(),
    now: () => 12000,
  });
  const newManifest = { ...replacement().manifest, runtime: legacy.packages[0].manifest.runtime };
  const archive = await packageArchive({ packageManifest: newManifest });
  const entry = catalogEntry(archive.integrity, { pluginId: oldManifest.pluginId, version: newManifest.version });
  let bytes = Buffer.from('invalid archive');
  const { manager } = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [entry], status: 'fresh', checkedAt: 12000 }) },
    catalogManifests: [newManifest],
    fetchOfficialArchive: async () => bytes,
    now: () => 12000,
  });
  const projected = (await manager.get(oldManifest.pluginId)).plugin;
  assert.equal(projected.actions.install, true);
  assert.equal(projected.packageDigest, digest('old'));
  assert.deepEqual(projected.source, { kind: 'unknown', packageName: null, trust: 'unknown' });
  const request = { expectedVersion: projected.availableVersion, expectedRevision: projected.lifecycleRevision };
  const before = await runtime.inventoryStore.snapshot();
  await assert.rejects(manager.update(oldManifest.pluginId, request));
  assert.deepEqual(await runtime.inventoryStore.snapshot(), before);
  assert.equal(await readFile(join(dataDir, 'user-data.txt'), 'utf8'), 'keep me');
  bytes = archive.bytes;
  const installed = await manager.update(oldManifest.pluginId, request);
  assert.equal(installed.pluginInstanceId, 'old-instance');
  assert.equal((await manager.get(oldManifest.pluginId)).plugin.intent, 'disabled');
  assert.equal((await manager.get(oldManifest.pluginId)).plugin.diagnostic?.code, undefined);
  assert.equal(await readFile(join(dataDir, 'user-data.txt'), 'utf8'), 'keep me');
  assert.equal((await runtime.inventoryStore.snapshot()).instances[0].packageDigest, entry.packageDigest);
});

test('historical capability diagnostics survive old inventory and expire on compatible replacement', async () => {
  const snapshot = oldSnapshot();
  snapshot.instances[0].lastRuntimeError = { code: 'PERMISSION_DENIED', exitCode: null, signal: null, occurredAt: 2 };
  snapshot.instances[0].lastRuntimeErrorDetail = {
    kind: 'capability_not_granted',
    capability: 'events.publish',
    occurredAt: 2,
    packageDigest: digest('old'),
  };
  assert.deepEqual(
    parsePluginInventorySnapshot(snapshot).instances[0].lastRuntimeErrorDetail,
    snapshot.instances[0].lastRuntimeErrorDetail,
  );
  const root = await mkdtemp(join(tmpdir(), 'plugin-retired-diagnostic-'));
  const path = join(root, 'inventory.json');
  await writeFile(path, JSON.stringify(snapshot));
  const store = new FilePluginInventoryStore(path);
  await new HostInventoryControlPlane(store).upgradePackage({
    ...replacement(),
    pluginInstanceId: 'old-instance',
    expectedLifecycleRevision: 1,
    expectedGrantRevision: 1,
  });
  assert.equal((await store.snapshot()).instances[0].lastRuntimeErrorDetail, undefined);
});
