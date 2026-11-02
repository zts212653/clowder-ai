import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HostInventoryControlPlane, MemoryPluginInventoryStore } from '../dist/domains/plugin/index.js';
import { prepareInitialPluginInstallation } from '../dist/domains/plugin/manager/initial-plugin-installation.js';
import { manifest } from './plugin-official-package-installer.fixture.js';

async function fixture() {
  const inventory = new MemoryPluginInventoryStore();
  let count = 0;
  const control = new HostInventoryControlPlane(inventory, { createInstanceId: () => `pi_${++count}`, now: () => 100 });
  const installed = [],
    activated = [],
    errors = [];
  const entries = ['first', 'second'].map((id) => ({
    catalogId: id,
    pluginId: `test.${id}`,
    version: '0.1.0-alpha.1',
    packageDigest: `sha512-${Buffer.alloc(64, id.length).toString('base64')}`,
  }));
  const install = async (id, release) => {
    const e = entries.find((entry) => entry.catalogId === id);
    assert.deepEqual(release, { version: e.version, packageDigest: e.packageDigest });
    installed.push(id);
    return control.installPackage({
      manifest: manifest({ pluginId: e.pluginId, signals: undefined }),
      computedPackageDigest: e.packageDigest,
      expectedPackageDigest: e.packageDigest,
      packagePluginId: e.pluginId,
    });
  };
  const options = {
    statePath: join(await mkdtemp(join(tmpdir(), 'c1-initial-install-')), 'initial.json'),
    inventory,
    catalog: { snapshot: async () => ({ entries, status: 'fresh', checkedAt: 100 }) },
    loadSelection: async () => ({
      schemaVersion: 1,
      plugins: entries.map((e) => ({ pluginId: e.pluginId, enabled: true })),
    }),
    installer: {
      install,
      installFromSnapshot: async (snapshot, id, release) => {
        assert.ok(snapshot.entries.some((entry) => entry.catalogId === id));
        return install(id, release);
      },
    },
    activate: async (id, instance) => {
      activated.push([id, instance]);
    },
    onFailure: (id, error) => errors.push([id, String(error)]),
  };
  return { options, inventory, installed, activated, errors };
}

test('first start installs the explicit selection at exact releases, activation waits until Host is listening', async () => {
  const f = await fixture();
  const ready = await prepareInitialPluginInstallation(f.options);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.installed, ['first', 'second']);
  assert.equal(f.activated.length, 0);
  await ready.activate();
  assert.equal(f.activated.length, 2);
  const journal = JSON.parse(await readFile(f.options.statePath, 'utf8'));
  assert.ok(journal.plugins.every((p) => p.done));
});

test('partial installation retries only the failed package after restart', async () => {
  const f = await fixture();
  const install = f.options.installer.install;
  const installFromSnapshot = f.options.installer.installFromSnapshot;
  let fail = true;
  f.options.installer.install = async (id, release) => {
    if (id === 'second' && fail) throw Error('offline');
    return install(id, release);
  };
  f.options.installer.installFromSnapshot = async (snapshot, id, release) => {
    if (id === 'second' && fail) throw Error('offline');
    return installFromSnapshot(snapshot, id, release);
  };
  await (await prepareInitialPluginInstallation(f.options)).activate();
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.installed, ['first']);
  fail = false;
  await (await prepareInitialPluginInstallation(f.options)).activate();
  assert.deepEqual(f.installed, ['first', 'second']);
  assert.equal(f.activated.length, 2);
});

test('first start installs the release captured by its catalog snapshot when discovery advances', async () => {
  const f = await fixture();
  const install = f.options.installer.install;
  let ordinaryInstalls = 0;
  f.options.installer = {
    install: async () => {
      ordinaryInstalls += 1;
      throw new Error('the live catalog advanced');
    },
    installFromSnapshot: async (snapshot, catalogId, release) => {
      const entry = snapshot.entries.find((candidate) => candidate.catalogId === catalogId);
      assert.ok(entry);
      assert.equal(entry.version, release.version);
      assert.equal(entry.packageDigest, release.packageDigest);
      return install(entry.catalogId, release);
    },
  };

  await (await prepareInitialPluginInstallation(f.options)).activate();

  assert.equal(ordinaryInstalls, 0);
  assert.deepEqual(f.installed, ['first', 'second']);
  assert.equal(f.activated.length, 2);
});

test('uninstall history and completed first start prevent automatic reinstallation', async () => {
  const f = await fixture();
  await (await prepareInitialPluginInstallation(f.options)).activate();
  await f.inventory.transaction((tx) => {
    for (const p of tx.instances.list()) tx.instances.put({ ...p, lifecycleState: 'retired', retiredAt: 100 });
  });
  await (await prepareInitialPluginInstallation(f.options)).activate();
  assert.deepEqual(f.installed, ['first', 'second']);
  const other = await fixture();
  // An existing installation without a first-start journal is not a virgin Host.
  await other.options.installer.install('first', {
    version: '0.1.0-alpha.1',
    packageDigest: (await other.options.catalog.snapshot()).entries[0].packageDigest,
  });
  await (await prepareInitialPluginInstallation(other.options)).activate();
  assert.deepEqual(other.installed, ['first']);
  assert.equal(other.activated.length, 0);
});

test('an owner change between admission and activation wins over the default', async () => {
  const f = await fixture();
  const ready = await prepareInitialPluginInstallation(f.options);
  await f.inventory.transaction((tx) => {
    const first = tx.instances.list()[0];
    tx.instances.put({ ...first, lifecycleRevision: first.lifecycleRevision + 1 });
  });
  await ready.activate();
  assert.deepEqual(
    f.activated.map((a) => a[0]),
    ['test.second'],
  );
  await (await prepareInitialPluginInstallation(f.options)).activate();
  assert.equal(f.activated.length, 1);
});

test('missing releases and unavailable discovery do not record a completed first start', async () => {
  const f = await fixture();
  const snapshot = f.options.catalog.snapshot;
  f.options.catalog.snapshot = async () => ({ entries: [], status: 'unavailable' });
  await assert.rejects(prepareInitialPluginInstallation(f.options), /current catalog/);
  await assert.rejects(readFile(f.options.statePath), { code: 'ENOENT' });
  f.options.catalog.snapshot = async () => ({ entries: [], status: 'fresh' });
  await assert.rejects(prepareInitialPluginInstallation(f.options), /absent from catalog/);
  assert.equal(f.installed.length, 0);
  f.options.catalog.snapshot = snapshot;
  await (await prepareInitialPluginInstallation(f.options)).activate();
  assert.equal(f.activated.length, 2);
});

for (const requiresConfig of [false, true])
  test(`production first start preserves lifecycle and uninstall (requiresConfig=${requiresConfig})`, async () => {
    const { prepareHostInitialPlugins } = await import('../dist/domains/plugin/manager/initial-plugin-installation.js');
    const { createDormantPluginRuntimeComposition, createPluginManagerRuntimeComposition } = await import(
      '../dist/domains/plugin/index.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { packageArchive, catalogEntry } = await import('./plugin-official-package-installer.fixture.js');
    const pluginManifest = manifest({
      ...(requiresConfig
        ? { configuration: [{ key: 'apiKey', label: 'API key', kind: 'secret', required: true }] }
        : {}),
      signals: undefined,
      features: [{ id: 'core', name: 'Core', resources: [], capabilities: [] }],
      runtime: { transport: 'builtin', entrypoint: 'dist/entrypoint.js' },
    });
    const archive = await packageArchive({
      packageManifest: pluginManifest,
      extraFiles: {
        'dist/entrypoint.js': 'export default {create(){return {async start(){return {actions:{},async stop(){}}}}}};',
      },
    });
    const entry = catalogEntry(archive.integrity, {});
    let catalogReads = 0;
    const catalog = {
      snapshot: async () => {
        catalogReads += 1;
        return { entries: [entry], status: 'fresh', checkedAt: 100 };
      },
    };
    const projectRoot = await mkdtemp(join(tmpdir(), 'c1-initial-production-'));
    let fetches = 0;
    const make = () => {
      const runtime = createDormantPluginRuntimeComposition({ projectRoot, messageStore: new MessageStore() });
      const managerRuntime = createPluginManagerRuntimeComposition({
        runtime,
        catalogProvider: catalog,
        catalogManifests: [],
        fetchOfficialArchive: async () => {
          fetches++;
          return archive.bytes;
        },
      });
      return {
        runtime,
        managerRuntime,
        catalog,
        loadSelection: async () => ({ schemaVersion: 1, plugins: [{ pluginId: entry.pluginId, enabled: true }] }),
        onFailure: (_id, error) => {
          throw error;
        },
      };
    };
    let host = make();
    try {
      const ready = await prepareHostInitialPlugins(host);
      assert.equal((await host.managerRuntime.manager.get(entry.pluginId)).plugin.intent, 'disabled');
      await host.runtime.recoverAfterRestart();
      const readsBeforeActivation = catalogReads;
      await ready.activate();
      if (!requiresConfig) {
        assert.equal(
          catalogReads,
          readsBeforeActivation,
          'first-start activation must reuse the operation catalog snapshot',
        );
      }
      let p = (await host.managerRuntime.manager.get(entry.pluginId)).plugin;
      if (requiresConfig) {
        assert.equal(p.intent, 'disabled');
        assert.equal((await host.runtime.inventoryStore.snapshot()).instances[0].configReadiness, 'incomplete');
        const before = await host.runtime.inventoryStore.snapshot();
        await assert.rejects(host.runtime.supervisor.start(p.pluginInstanceId), { code: 'INSTANCE_NOT_RUNNABLE' });
        await assert.rejects(host.runtime.supervisor.invoke(p.pluginInstanceId, 'probe', {}));
        assert.deepEqual(await host.runtime.inventoryStore.snapshot(), before);
      } else {
        assert.equal(p.intent, 'enabled');
        assert.equal(p.live, 'running');
        await host.managerRuntime.manager.setEnabled(entry.pluginId, {
          enabled: false,
          expectedRevision: p.lifecycleRevision,
        });
      }
      p = (await host.managerRuntime.manager.get(entry.pluginId)).plugin;
      await host.managerRuntime.manager.uninstall(entry.pluginId, { expectedRevision: p.lifecycleRevision });
    } finally {
      await host.runtime.shutdown('test');
    }
    host = make();
    try {
      await (await prepareHostInitialPlugins(host)).activate();
      assert.equal(fetches, 1);
      assert.equal((await host.runtime.inventoryStore.snapshot()).instances[0].lifecycleState, 'retired');
    } finally {
      await host.runtime.shutdown('test');
    }
  });

test('the zero-capability GenOffice default remains discoverable in the official catalog', async () => {
  const { MachineOfficialPluginCatalog } = await import('../dist/domains/plugin/manager/machine-catalog-provider.js');
  const catalog = new MachineOfficialPluginCatalog({
    validateCatalog: (value) => ({ valid: true, catalog: value }),
    loadCatalog: async () => ({
      plugins: [
        {
          pluginId: 'dev.clowder.genoffice-docx',
          name: 'GenOffice',
          publisher: { name: 'Clowder AI' },
          versions: [
            {
              version: '0.1.0-alpha.2',
              artifact: {
                packageName: '@clowder-ai/genoffice-docx',
                tarballUrl: 'https://registry.npmjs.org/fixture.tgz',
                integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
              },
            },
          ],
        },
      ],
    }),
  });
  const entries = (await catalog.snapshot()).entries;
  assert.equal(entries.length, 1);
});

test('a configuration failure after admission retries setup without reinstalling the admitted instance', async () => {
  const f = await fixture();
  let fail = true;
  f.options.reconcile = async () => {
    if (fail) throw Error('configuration unavailable');
  };
  const first = await prepareInitialPluginInstallation(f.options);
  await first.activate();
  assert.equal(f.activated.length, 0);
  assert.equal(f.errors.length, 2);
  fail = false;
  await (await prepareInitialPluginInstallation(f.options)).activate();
  assert.deepEqual(f.installed, ['first', 'second']);
  assert.equal(f.activated.length, 2);
});
