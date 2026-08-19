import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
  PLUGIN_CONTRACT_PACKAGE_VERSION,
  PLUGIN_CONTRACT_VERSION,
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
    effectiveGrants: ['messaging.send'],
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
  it('pins the API and runtime boundary to plugin-contract beta.9', () => {
    assert.equal(packageJson.dependencies['@clowder-ai/plugin-contract'], '0.1.0-beta.9');
    assert.equal(PLUGIN_CONTRACT_PACKAGE_VERSION, '0.1.0-beta.9');
    assert.equal(PLUGIN_CONTRACT_VERSION, '0.1.0');
  });

  it('installs package, instance, and grants atomically with orthogonal initial state', async () => {
    const { store, controlPlane } = harness();
    const installed = await controlPlane.installPackage(candidate());
    const snapshot = await store.snapshot();

    assert.equal(installed.pluginInstanceId, 'pi_1');
    assert.equal(snapshot.packages.length, 1);
    assert.equal(snapshot.instances.length, 1);
    assert.equal(snapshot.grants.length, 1);
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
    assert.deepEqual(snapshot.grants[0].requestedCapabilities, ['messaging.send', 'onMessage']);
    assert.deepEqual(snapshot.grants[0].effectiveGrants, ['messaging.send']);
    assert.equal(snapshot.grants[0].grantRevision, 1);
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
        runtimeState: 'healthy',
      });
    });

    const upgradedManifest = manifest({
      version: '2.0.0',
      features: [{ id: 'messaging', name: 'Messaging', resources: [], capabilities: ['messaging.send'] }],
    });
    const upgraded = await controlPlane.upgradePackage({
      pluginInstanceId: installed.pluginInstanceId,
      expectedLifecycleRevision: 1,
      expectedGrantRevision: 1,
      ...candidate({
        archive: 'echo-v2',
        manifest: upgradedManifest,
        packagePluginId: upgradedManifest.pluginId,
      }),
    });
    const snapshot = await store.snapshot();
    const instance = snapshot.instances.find((item) => item.pluginInstanceId === upgraded.pluginInstanceId);
    const grants = snapshot.grants.find((item) => item.pluginInstanceId === upgraded.pluginInstanceId);

    assert.equal(upgraded.pluginInstanceId, installed.pluginInstanceId);
    assert.equal(instance.configReadiness, 'ready');
    assert.equal(instance.activationState, 'disabled');
    assert.equal(instance.runtimeState, 'stopped');
    assert.equal(grants.grantRevision, 2);
    assert.deepEqual(grants.requestedCapabilities, ['messaging.send']);
    assert.deepEqual(grants.effectiveGrants, ['messaging.send']);
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
    assert.equal(snapshot.grants.find((item) => item.pluginInstanceId === 'pi_1').grantRevision, 1);
    assert.equal(snapshot.grants.find((item) => item.pluginInstanceId === 'pi_2').grantRevision, 1);
  });

  it('revokes one grant at the exact revision without mutating other axes', async () => {
    const { store, controlPlane } = harness();
    const installed = await controlPlane.installPackage(
      candidate({ effectiveGrants: ['messaging.send', 'onMessage'] }),
    );
    await store.transaction((tx) => {
      const current = tx.instances.get(installed.pluginInstanceId);
      tx.instances.put({ ...current, activationState: 'enabled', runtimeState: 'healthy' });
    });
    const before = await store.snapshot();

    const revision = await controlPlane.revokeGrant({
      pluginInstanceId: installed.pluginInstanceId,
      capability: 'onMessage',
      expectedGrantRevision: 1,
    });
    const after = await store.snapshot();

    assert.equal(revision, 2);
    assert.deepEqual(after.packages, before.packages);
    assert.equal(after.instances[0].activationState, 'enabled');
    assert.equal(after.instances[0].runtimeState, 'healthy');
    assert.deepEqual(after.grants[0].effectiveGrants, ['messaging.send']);
  });
});
