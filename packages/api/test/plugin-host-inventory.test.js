import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
  PLUGIN_CONTRACT_PACKAGE_VERSION,
  PLUGIN_CONTRACT_VERSION,
  PLUGIN_MANIFEST_CONTRACT_RANGE,
} from '../dist/domains/plugin/host-inventory/index.js';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function digest(value) {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

function manifest(overrides = {}) {
  return {
    pluginId: 'dev.clowder.echo',
    version: '1.0.0',
    contractVersion: PLUGIN_CONTRACT_VERSION,
    name: 'Echo',
    features: [
      {
        id: 'messaging',
        name: 'Messaging',
        resources: [],
        capabilities: ['messaging.send', 'onMessage'],
      },
    ],
    runtime: { transport: 'builtin' },
    ...overrides,
  };
}

function candidate(overrides = {}) {
  const computedPackageDigest = overrides.computedPackageDigest ?? digest(overrides.archive ?? 'echo-v1');
  const packageManifest = overrides.manifest ?? manifest();
  return {
    manifest: packageManifest,
    computedPackageDigest,
    expectedPackageDigest: computedPackageDigest,
    packagePluginId: packageManifest.pluginId,
    ...overrides,
  };
}

function harness() {
  const store = new MemoryPluginInventoryStore();
  let nextId = 1;
  let now = 1_000;
  const controlPlane = new HostInventoryControlPlane(store, {
    createInstanceId: () => `pi_${nextId++}`,
    now: () => now++,
  });
  return { store, controlPlane };
}

describe('K-2A contract-native inventory', () => {
  it('pins the consumed contract candidate archive and preserves older manifest compatibility', () => {
    assert.equal(
      packageJson.dependencies['@clowder-ai/plugin-contract'],
      'file:vendor/clowder-ai-plugin-contract-0.3.1-candidate.0-f327-3edd45d1c7ba.tgz',
    );
    const archive = readFileSync(
      new URL('../vendor/clowder-ai-plugin-contract-0.3.1-candidate.0-f327-3edd45d1c7ba.tgz', import.meta.url),
    );
    assert.equal(
      createHash('sha256').update(archive).digest('hex'),
      '3edd45d1c7ba35dae56ccafd10225be52acc7689f91f8bcad7483c0fa84300af',
    );
    assert.equal(PLUGIN_CONTRACT_PACKAGE_VERSION, '0.3.1-candidate.0');
    assert.equal(PLUGIN_CONTRACT_VERSION, '0.1.0');
    assert.equal(PLUGIN_MANIFEST_CONTRACT_RANGE, `>=0.1.0-beta.13 <=${PLUGIN_CONTRACT_PACKAGE_VERSION}`);
  });

  it('rejects a traversal entrypoint before admitting any package or instance', async () => {
    const { store, controlPlane } = harness();
    await assert.rejects(
      controlPlane.installPackage(
        candidate({ manifest: manifest({ runtime: { transport: 'stdio', entrypoint: '../outside.js' } }) }),
      ),
      { code: 'INVALID_MANIFEST' },
    );
    const snapshot = await store.snapshot();
    assert.deepEqual(snapshot.packages, []);
    assert.deepEqual(snapshot.instances, []);
  });

  it('installs package and instance atomically with orthogonal initial state', async () => {
    const { store, controlPlane } = harness();
    const installed = await controlPlane.installPackage(candidate());
    const snapshot = await store.snapshot();

    assert.equal(installed.pluginInstanceId, 'pi_1');
    assert.equal(snapshot.packages.length, 1);
    assert.equal(snapshot.instances.length, 1);
    assert.deepEqual(snapshot.instances[0], {
      pluginInstanceId: 'pi_1',
      pluginId: 'dev.clowder.echo',
      packageDigest: candidate().computedPackageDigest,
      lifecycleState: 'installed',
      configReadiness: 'incomplete',
      activationState: 'disabled',
      runtimeState: 'stopped',
      lifecycleRevision: 1,
      installedAt: 1_000,
      updatedAt: 1_000,
    });
  });

  it('admits the installed beta lines and the currently consumed contract', async () => {
    for (const contractVersion of [
      '0.1.0-beta.20',
      '0.1.0-beta.21',
      '0.1.0-beta.22',
      '0.1.0-beta.24',
      PLUGIN_CONTRACT_PACKAGE_VERSION,
    ]) {
      const { store, controlPlane } = harness();
      const packageManifest = manifest({ contractVersion });

      await controlPlane.installPackage(candidate({ manifest: packageManifest }));

      const snapshot = await store.snapshot();
      assert.equal(snapshot.packages[0].contractVersion, contractVersion);
    }
  });

  for (const contractVersion of [
    '0.1.0-beta.13',
    '0.1.0-beta.15',
    '0.1.0-beta.16',
    '0.1.0-beta.17',
    '0.1.0-beta.18',
    '0.1.0-beta.19',
    '0.1.0-beta.20',
  ]) {
    it(`restores an admitted ${contractVersion} inventory without changing its identity`, async () => {
      const { store, controlPlane } = harness();
      await controlPlane.installPackage(candidate({ manifest: manifest({ contractVersion }) }));
      const saved = await store.snapshot();
      const restored = new MemoryPluginInventoryStore(JSON.parse(JSON.stringify(saved)));
      assert.deepEqual(await restored.snapshot(), saved);
    });
  }

  it('admits compatible declarations without enumerating every library release', async () => {
    for (const contractVersion of [
      '0.1.0-beta.14',
      '0.1.0-beta.23',
      '0.1.0-beta.99',
      '0.1.1',
      '0.2.0-beta.1',
      '0.2.0+build.1',
      '0.3.1-beta.1',
    ]) {
      const { store, controlPlane } = harness();
      await controlPlane.installPackage(candidate({ manifest: manifest({ contractVersion }) }));
      assert.equal((await store.snapshot()).packages[0].contractVersion, contractVersion);
    }
  });

  it('rejects declarations below the compatibility floor or above the implemented contract without writes', async () => {
    for (const contractVersion of ['0.0.99', '0.1.0-beta.12', '0.3.1-candidate.1', '0.3.1', '0.4.0', '1.0.0']) {
      const { store, controlPlane } = harness();
      const before = await store.snapshot();
      await assert.rejects(controlPlane.installPackage(candidate({ manifest: manifest({ contractVersion }) })), {
        code: 'CONTRACT_VERSION_MISMATCH',
      });
      assert.deepEqual(await store.snapshot(), before);
    }
  });

  it('keeps a plugin declaration unchanged when the Host consumes a newer contract package', async () => {
    const { store, controlPlane } = harness();
    await controlPlane.installPackage(candidate({ manifest: manifest({ contractVersion: '0.1.0' }) }));
    assert.notEqual(PLUGIN_CONTRACT_PACKAGE_VERSION, '0.1.0');
    assert.equal((await store.snapshot()).packages[0].manifest.contractVersion, '0.1.0');
  });

  it('rejects a newer contract without admitting any inventory', async () => {
    const { store, controlPlane } = harness();
    await assert.rejects(controlPlane.installPackage(candidate({ manifest: manifest({ contractVersion: '0.3.1' }) })), {
      code: 'CONTRACT_VERSION_MISMATCH',
    });
    assert.deepEqual((await store.snapshot()).packages, []);
  });

  it('can bind admission to an exact newer contract runtime using the selected contract runtime', async () => {
    const exactManifest = manifest({
      contractVersion: '0.1.0-beta.13',
      features: [
        {
          id: 'analysis',
          name: 'Analysis',
          resources: [],
          capabilities: ['plugin.config.read', 'secret.read'],
        },
      ],
    });
    const contract = {
      manifestContractRange: '0.1.0-beta.13',
      validateManifest: (value) => ({ valid: true, manifest: value, errors: [] }),
    };
    const store = new MemoryPluginInventoryStore(undefined, { contract });
    const controlPlane = new HostInventoryControlPlane(store, {
      createInstanceId: () => 'pi_exact_contract',
      now: () => 2_000,
      contract,
    });

    await controlPlane.installPackage(
      candidate({
        manifest: exactManifest,
        packagePluginId: exactManifest.pluginId,
      }),
    );

    const snapshot = await store.snapshot();
    assert.equal(snapshot.packages[0].contractVersion, '0.1.0-beta.13');
  });

  it('upgrades the current installation without changing its identity', async () => {
    const { store, controlPlane } = harness();
    const installed = await controlPlane.installPackage(candidate());
    await store.transaction((tx) => {
      const current = tx.instances.get(installed.pluginInstanceId);
      tx.instances.put({
        ...current,
        configReadiness: 'ready',
        activationState: 'enabled',
        runtimeState: 'stopped',
      });
    });

    const upgradedManifest = manifest({
      version: '2.0.0',
      features: [{ id: 'messaging', name: 'Messaging', resources: [], capabilities: ['messaging.send'] }],
    });
    const upgraded = await controlPlane.upgradePackage({
      pluginInstanceId: installed.pluginInstanceId,
      expectedLifecycleRevision: 1,
      ...candidate({
        archive: 'echo-v2',
        manifest: upgradedManifest,
        packagePluginId: upgradedManifest.pluginId,
      }),
    });
    const snapshot = await store.snapshot();
    const instance = snapshot.instances.find((item) => item.pluginInstanceId === upgraded.pluginInstanceId);

    assert.equal(upgraded.pluginInstanceId, installed.pluginInstanceId);
    assert.equal(instance.configReadiness, 'ready');
    assert.equal(instance.activationState, 'enabled');
    assert.equal(instance.runtimeState, 'stopped');
  });

  it('reinstall mints a fresh namespace and retires the prior instance', async () => {
    const { store, controlPlane } = harness();
    const installed = await controlPlane.installPackage(candidate());
    const reinstalled = await controlPlane.reinstallPackage({
      previousPluginInstanceId: installed.pluginInstanceId,
      ...candidate(),
    });
    const snapshot = await store.snapshot();
    const oldInstance = snapshot.instances.find((item) => item.pluginInstanceId === installed.pluginInstanceId);
    const newInstance = snapshot.instances.find((item) => item.pluginInstanceId === reinstalled.pluginInstanceId);

    assert.equal(reinstalled.pluginInstanceId, 'pi_2');
    assert.equal(oldInstance.lifecycleState, 'retired');
    assert.equal(oldInstance.runtimeState, 'stopped');
    assert.equal(newInstance.lifecycleState, 'installed');
  });
});
