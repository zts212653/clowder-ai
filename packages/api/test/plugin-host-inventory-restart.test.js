import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
import {
  FilePluginInventoryStore,
  HostInventoryControlPlane,
  PLUGIN_CONTRACT_VERSION,
} from '../dist/domains/plugin/host-inventory/index.js';

function digest(value) {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

function candidate() {
  const computedPackageDigest = digest('restart-v1');
  return {
    manifest: {
      pluginId: 'dev.clowder.restart',
      version: '1.0.0',
      contractVersion: PLUGIN_CONTRACT_VERSION,
      name: 'Restart',
      features: [{ id: 'messaging', name: 'Messaging', resources: [], capabilities: ['messaging.send'] }],
      runtime: { transport: 'builtin' },
    },
    computedPackageDigest,
    expectedPackageDigest: computedPackageDigest,
    packagePluginId: 'dev.clowder.restart',
  };
}

describe('K-2A persisted restart normalization', () => {
  it('uses the same narrowed compatibility range for admission and persisted packages', async (t) => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-inventory-narrow-contract-range-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'inventory.json');
    const originalStore = new FilePluginInventoryStore(path);
    const original = new HostInventoryControlPlane(originalStore, { createInstanceId: () => 'pi_range' });
    const admitted = candidate();
    admitted.manifest.contractVersion = '0.1.1';
    await original.installPackage(admitted);
    const before = await originalStore.snapshot();
    const bytes = readFileSync(path, 'utf8');
    const contract = {
      manifestContractRange: '>=0.1.0-beta.13 <0.1.1 || >=0.2.0 <=0.2.0',
      validateManifest,
    };
    const store = new FilePluginInventoryStore(path, { contract });
    const current = new HostInventoryControlPlane(store, { contract });
    await assert.rejects(current.installPackage(admitted), { code: 'CONTRACT_VERSION_MISMATCH' });
    const recovered = await store.snapshot();
    assert.equal(recovered.packages[0].manifest, null);
    assert.deepEqual(recovered.packages[0].incompatibleManifest, before.packages[0].manifest);
    assert.deepEqual(recovered.instances, before.instances);
    assert.equal(readFileSync(path, 'utf8'), bytes);

    admitted.manifest.contractVersion = '0.2.0';
    const compatibleStore = new FilePluginInventoryStore(join(root, 'compatible.json'), { contract });
    await new HostInventoryControlPlane(compatibleStore, { contract }).installPackage(admitted);
    assert.equal((await compatibleStore.snapshot()).packages[0].contractVersion, '0.2.0');
  });

  it('restores an in-range declaration without a release-specific entry or rewriting its authority', async (t) => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-inventory-contract-range-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'inventory.json');
    const previousContract = {
      manifestContractRange: '0.1.1',
      validateManifest,
    };
    const firstStore = new FilePluginInventoryStore(path, { contract: previousContract });
    const first = new HostInventoryControlPlane(firstStore, {
      contract: previousContract,
      createInstanceId: () => 'pi_range',
      now: () => 3_000,
    });
    const admitted = candidate();
    admitted.manifest.contractVersion = '0.1.1';
    await first.installPackage(admitted);
    await firstStore.transaction((tx) => {
      tx.instances.put({
        ...tx.instances.get('pi_range'),
        configReadiness: 'ready',
        activationState: 'enabled',
        runtimeState: 'stopped',
      });
    });
    const before = await firstStore.snapshot();
    const bytes = readFileSync(path, 'utf8');
    const restoredStore = new FilePluginInventoryStore(path);
    const restored = new HostInventoryControlPlane(restoredStore, { now: () => 4_000 });
    assert.equal(await restored.recoverAfterRestart(), 0);
    assert.deepEqual(await restoredStore.snapshot(), before);
    assert.equal(readFileSync(path, 'utf8'), bytes);
  });

  it('opens inventory admitted by the published beta.15 Host without changing persisted authority', async (t) => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-inventory-beta15-upgrade-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'inventory.json');
    // Public Host b1fe2966 admitted these exact versions before the beta.16 bump.
    // Keep real manifest validators; only the historical version policy differs.
    const previousContract = {
      manifestContractRange: '0.1.0 || 0.1.0-beta.13 || 0.1.0-beta.15',
      validateManifest,
    };
    const previousStore = new FilePluginInventoryStore(path, { contract: previousContract });
    const previousHost = new HostInventoryControlPlane(previousStore, {
      contract: previousContract,
      createInstanceId: () => 'pi_beta15',
      now: () => 3_000,
    });
    const admitted = candidate();
    admitted.manifest.contractVersion = '0.1.0-beta.15';
    await previousHost.installPackage(admitted);
    await previousStore.transaction((tx) => {
      tx.instances.put({
        ...tx.instances.get('pi_beta15'),
        configReadiness: 'ready',
        activationState: 'enabled',
        runtimeState: 'stopped',
      });
    });
    const before = await previousStore.snapshot();
    const persistedBytes = readFileSync(path, 'utf8');

    const currentStore = new FilePluginInventoryStore(path);
    const currentHost = new HostInventoryControlPlane(currentStore, { now: () => 4_000 });
    assert.equal(await currentHost.recoverAfterRestart(), 0);
    assert.deepEqual(await currentStore.snapshot(), before);
    assert.equal(readFileSync(path, 'utf8'), persistedBytes);
  });

  it('reloads durable axes and resets only interrupted runtime progress', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-inventory-restart-'));
    const path = join(root, 'inventory.json');
    const firstStore = new FilePluginInventoryStore(path);
    const first = new HostInventoryControlPlane(firstStore, {
      createInstanceId: () => 'pi_restart',
      now: () => 3_000,
    });
    await first.installPackage(candidate());
    await firstStore.transaction((tx) => {
      const instance = tx.instances.get('pi_restart');
      tx.instances.put({
        ...instance,
        configReadiness: 'ready',
        activationState: 'enabling',
        runtimeState: 'healthy',
        lastRuntimeError: {
          code: 'EVENT_BUS_CONFLICT',
          exitCode: 17,
          signal: null,
          occurredAt: 3_500,
        },
      });
    });
    const before = await firstStore.snapshot();

    const restartedStore = new FilePluginInventoryStore(path);
    const restarted = new HostInventoryControlPlane(restartedStore, { now: () => 4_000 });
    const changed = await restarted.recoverAfterRestart();
    const after = await restartedStore.snapshot();

    assert.equal(changed, 1);
    assert.deepEqual(after.packages, before.packages);
    assert.equal(after.instances[0].pluginInstanceId, 'pi_restart');
    assert.equal(after.instances[0].configReadiness, 'ready');
    assert.equal(after.instances[0].activationState, 'error');
    assert.equal(after.instances[0].runtimeState, 'stopped');
    assert.deepEqual(after.instances[0].lastRuntimeError, before.instances[0].lastRuntimeError);
    assert.equal(after.instances[0].updatedAt, 4_000);
  });

  it('fails closed on corrupted or unsupported persisted snapshots', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-inventory-corrupt-'));
    const corruptPath = join(root, 'corrupt.json');
    const futurePath = join(root, 'future.json');
    writeFileSync(corruptPath, '{not-json');
    writeFileSync(futurePath, JSON.stringify({ schemaVersion: 99, packages: [], instances: [] }));

    await assert.rejects(
      () => new FilePluginInventoryStore(corruptPath).snapshot(),
      (error) => error?.code === 'CORRUPT_SNAPSHOT',
    );
    await assert.rejects(
      () => new FilePluginInventoryStore(futurePath).snapshot(),
      (error) => error?.code === 'UNSUPPORTED_SCHEMA',
    );
  });

  it('preserves explicit enabled intent when restart finds the old runtime already stopped', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-inventory-dormant-restart-'));
    const path = join(root, 'inventory.json');
    const store = new FilePluginInventoryStore(path);
    const first = new HostInventoryControlPlane(store, {
      createInstanceId: () => 'pi_restart',
      now: () => 3_000,
    });
    await first.installPackage(candidate());
    await store.transaction((tx) => {
      const instance = tx.instances.get('pi_restart');
      tx.instances.put({
        ...instance,
        configReadiness: 'ready',
        activationState: 'enabled',
        runtimeState: 'stopped',
      });
    });

    const restartedStore = new FilePluginInventoryStore(path);
    const restarted = new HostInventoryControlPlane(restartedStore, { now: () => 4_000 });
    assert.equal(await restarted.recoverAfterRestart(), 0);
    const recovered = (await restartedStore.snapshot()).instances[0];
    assert.equal(recovered.activationState, 'enabled');
    assert.equal(recovered.runtimeState, 'stopped');
    assert.equal(recovered.lifecycleRevision, 1);
  });

  it('rejects runtime diagnostics with unrecognized fields instead of persisting raw detail', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-inventory-runtime-diagnostic-'));
    const path = join(root, 'inventory.json');
    const store = new FilePluginInventoryStore(path);
    const controlPlane = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_restart' });
    await controlPlane.installPackage(candidate());
    const snapshot = await store.snapshot();
    snapshot.instances[0].lastRuntimeError = {
      code: 'EVENT_BUS_CONFLICT',
      exitCode: 17,
      signal: null,
      occurredAt: 3_500,
      rawMessage: 'must not persist',
    };
    writeFileSync(path, JSON.stringify(snapshot));

    await assert.rejects(
      () => new FilePluginInventoryStore(path).snapshot(),
      (error) => error?.code === 'CORRUPT_SNAPSHOT',
    );
    snapshot.instances[0].lastRuntimeError = {
      code: 'UNEXPECTED_RUNTIME_FAILURE',
      exitCode: null,
      signal: null,
      occurredAt: 3_500,
      desktopReason: '../raw-renderer-message',
    };
    writeFileSync(path, JSON.stringify(snapshot));
    await assert.rejects(
      () => new FilePluginInventoryStore(path).snapshot(),
      (error) => error?.code === 'CORRUPT_SNAPSHOT',
    );
  });

  it('retains packages outside the Host contract as incompatible without admitting them', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-inventory-stale-contract-'));
    const path = join(root, 'inventory.json');
    const store = new FilePluginInventoryStore(path);
    const controlPlane = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_restart' });
    await controlPlane.installPackage(candidate());
    const snapshot = await store.snapshot();
    snapshot.packages[0].manifest.contractVersion = '0.1.0-beta.5';
    snapshot.packages[0].contractVersion = '0.1.0-beta.5';
    writeFileSync(path, JSON.stringify(snapshot));

    const recovered = await new FilePluginInventoryStore(path).snapshot();
    assert.equal(recovered.packages[0].manifest, null);
    assert.deepEqual(recovered.packages[0].incompatibleManifest, snapshot.packages[0].manifest);
    assert.deepEqual(recovered.instances, snapshot.instances);
  });

  it('rejects a current installed instance backed by a quarantined package', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-inventory-quarantined-current-'));
    const path = join(root, 'inventory.json');
    const store = new FilePluginInventoryStore(path);
    const controlPlane = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_restart' });
    await controlPlane.installPackage(candidate());
    const snapshot = await store.snapshot();
    snapshot.packages[0].packageState = 'quarantined';
    writeFileSync(path, JSON.stringify(snapshot));

    await assert.rejects(
      () => new FilePluginInventoryStore(path).snapshot(),
      (error) => error?.code === 'CORRUPT_SNAPSHOT',
    );
  });
});
