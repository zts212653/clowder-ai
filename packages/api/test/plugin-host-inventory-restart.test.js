import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
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
    effectiveGrants: ['messaging.send'],
  };
}

describe('K-2A persisted restart normalization', () => {
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
    assert.deepEqual(after.grants, before.grants);
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
    writeFileSync(futurePath, JSON.stringify({ schemaVersion: 99, packages: [], instances: [], grants: [] }));

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

  it('rejects persisted grants that were not requested by the referenced package manifest', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-inventory-forged-grant-'));
    const path = join(root, 'inventory.json');
    const store = new FilePluginInventoryStore(path);
    const controlPlane = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_restart' });
    await controlPlane.installPackage(candidate());
    const snapshot = await store.snapshot();
    snapshot.grants[0].requestedCapabilities = ['onMessage'];
    snapshot.grants[0].effectiveGrants = ['onMessage'];
    writeFileSync(path, JSON.stringify(snapshot));

    await assert.rejects(
      () => new FilePluginInventoryStore(path).snapshot(),
      (error) => error?.code === 'CORRUPT_SNAPSHOT',
    );
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
  });

  it('rejects persisted packages outside the Host exact contract version', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-inventory-stale-contract-'));
    const path = join(root, 'inventory.json');
    const store = new FilePluginInventoryStore(path);
    const controlPlane = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_restart' });
    await controlPlane.installPackage(candidate());
    const snapshot = await store.snapshot();
    snapshot.packages[0].manifest.contractVersion = '0.1.0-beta.5';
    snapshot.packages[0].contractVersion = '0.1.0-beta.5';
    writeFileSync(path, JSON.stringify(snapshot));

    await assert.rejects(
      () => new FilePluginInventoryStore(path).snapshot(),
      (error) => error?.code === 'CORRUPT_SNAPSHOT',
    );
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
