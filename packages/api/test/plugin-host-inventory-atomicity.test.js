import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  FilePluginInventoryStore,
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
  PLUGIN_CONTRACT_VERSION,
} from '../dist/domains/plugin/host-inventory/index.js';

function digest(value) {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

function validManifest() {
  return {
    pluginId: 'dev.clowder.atomic',
    version: '1.0.0',
    contractVersion: PLUGIN_CONTRACT_VERSION,
    name: 'Atomic',
    features: [{ id: 'messaging', name: 'Messaging', resources: [], capabilities: ['messaging.send', 'onMessage'] }],
    runtime: { transport: 'builtin' },
  };
}

function candidate(overrides = {}) {
  const computedPackageDigest = digest('atomic-v1');
  return {
    manifest: validManifest(),
    computedPackageDigest,
    expectedPackageDigest: computedPackageDigest,
    packagePluginId: 'dev.clowder.atomic',
    effectiveGrants: ['messaging.send', 'onMessage'],
    ...overrides,
  };
}

function upgradedCandidate() {
  const computedPackageDigest = digest('atomic-v2');
  return candidate({
    manifest: { ...validManifest(), version: '2.0.0' },
    computedPackageDigest,
    expectedPackageDigest: computedPackageDigest,
  });
}

function service(store) {
  return new HostInventoryControlPlane(store, {
    createInstanceId: () => 'pi_atomic',
    now: () => 2_000,
  });
}

async function expectNoWrites(store, action, code) {
  const before = await store.snapshot();
  await assert.rejects(action, (error) => error?.code === code);
  assert.deepEqual(await store.snapshot(), before);
}

describe('K-2A fail-closed inventory writes', () => {
  it('invalid contract manifest writes no package, instance, or grant state', async () => {
    const store = new MemoryPluginInventoryStore();
    await expectNoWrites(
      store,
      () => service(store).installPackage(candidate({ manifest: { pluginId: 'missing-fields' } })),
      'INVALID_MANIFEST',
    );
  });

  it('digest mismatch during upgrade preserves the installed snapshot', async () => {
    const store = new MemoryPluginInventoryStore();
    const controlPlane = service(store);
    await controlPlane.installPackage(candidate());
    await expectNoWrites(
      store,
      () =>
        controlPlane.upgradePackage({
          pluginInstanceId: 'pi_atomic',
          expectedLifecycleRevision: 1,
          expectedGrantRevision: 1,
          ...candidate({
            computedPackageDigest: digest('atomic-v2'),
            expectedPackageDigest: digest('different'),
          }),
        }),
      'PACKAGE_DIGEST_MISMATCH',
    );
  });

  it('package identity mismatch writes no package, instance, or grant state', async () => {
    const store = new MemoryPluginInventoryStore();
    await expectNoWrites(
      store,
      () => service(store).installPackage(candidate({ packagePluginId: 'dev.clowder.other' })),
      'PACKAGE_ID_MISMATCH',
    );
  });

  it('unknown or unrequested effective grant writes nothing', async () => {
    const store = new MemoryPluginInventoryStore();
    await expectNoWrites(
      store,
      () => service(store).installPackage(candidate({ effectiveGrants: ['thread.readContent'] })),
      'INVALID_GRANT',
    );
  });

  it('stale grant revision is rejected with the entire snapshot unchanged', async () => {
    const store = new MemoryPluginInventoryStore();
    const controlPlane = service(store);
    await controlPlane.installPackage(candidate());
    await expectNoWrites(
      store,
      () =>
        controlPlane.revokeGrant({
          pluginInstanceId: 'pi_atomic',
          capability: 'onMessage',
          expectedGrantRevision: 0,
        }),
      'STALE_GRANT_REVISION',
    );
  });

  it('stale upgrade cannot restore a grant revoked after its expected revision', async () => {
    const store = new MemoryPluginInventoryStore();
    const controlPlane = service(store);
    await controlPlane.installPackage(candidate());
    await controlPlane.revokeGrant({
      pluginInstanceId: 'pi_atomic',
      capability: 'onMessage',
      expectedGrantRevision: 1,
    });

    await expectNoWrites(
      store,
      () =>
        controlPlane.upgradePackage({
          pluginInstanceId: 'pi_atomic',
          expectedLifecycleRevision: 1,
          expectedGrantRevision: 1,
          ...upgradedCandidate(),
        }),
      'STALE_GRANT_REVISION',
    );
  });

  it('stale lifecycle revision cannot update a package behind an owner action', async () => {
    const store = new MemoryPluginInventoryStore();
    const controlPlane = service(store);
    await controlPlane.installPackage(candidate());
    await store.transaction((transaction) => {
      const current = transaction.instances.get('pi_atomic');
      transaction.instances.put({ ...current, lifecycleRevision: 2 });
    });

    await expectNoWrites(
      store,
      () =>
        controlPlane.upgradePackage({
          pluginInstanceId: 'pi_atomic',
          expectedLifecycleRevision: 1,
          expectedGrantRevision: 1,
          ...upgradedCandidate(),
        }),
      'STALE_LIFECYCLE_REVISION',
    );
  });

  it('rejects a direct package swap while runtime authority is active without writing inventory', async () => {
    const store = new MemoryPluginInventoryStore();
    const controlPlane = service(store);
    await controlPlane.installPackage(candidate());
    await store.transaction((transaction) => {
      const current = transaction.instances.get('pi_atomic');
      transaction.instances.put({
        ...current,
        configReadiness: 'ready',
        activationState: 'enabled',
        runtimeState: 'healthy',
      });
    });

    await expectNoWrites(
      store,
      () =>
        controlPlane.upgradePackage({
          pluginInstanceId: 'pi_atomic',
          expectedLifecycleRevision: 1,
          expectedGrantRevision: 1,
          ...upgradedCandidate(),
        }),
      'RUNTIME_NOT_STOPPED',
    );
  });

  it('serializes upgrade versus revoke so exactly one revision-1 mutation commits', async () => {
    for (const firstOperation of ['upgrade', 'revoke']) {
      const store = new MemoryPluginInventoryStore();
      const baselineStore = new MemoryPluginInventoryStore();
      const controlPlane = service(store);
      const baseline = service(baselineStore);
      await controlPlane.installPackage(candidate());
      await baseline.installPackage(candidate());

      const operations = {
        upgrade: (target) =>
          target.upgradePackage({
            pluginInstanceId: 'pi_atomic',
            expectedLifecycleRevision: 1,
            expectedGrantRevision: 1,
            ...upgradedCandidate(),
          }),
        revoke: (target) =>
          target.revokeGrant({
            pluginInstanceId: 'pi_atomic',
            capability: 'onMessage',
            expectedGrantRevision: 1,
          }),
      };
      const secondOperation = firstOperation === 'upgrade' ? 'revoke' : 'upgrade';
      const results = await Promise.allSettled([
        operations[firstOperation](controlPlane),
        operations[secondOperation](controlPlane),
      ]);
      const winnerIndex = results.findIndex((result) => result.status === 'fulfilled');
      const loser = results.find((result) => result.status === 'rejected');

      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
      assert.equal(loser.reason?.code, 'STALE_GRANT_REVISION');

      const winner = winnerIndex === 0 ? firstOperation : secondOperation;
      await operations[winner](baseline);
      assert.deepEqual(await store.snapshot(), await baselineStore.snapshot());
    }
  });

  it('serializes concurrent grant CAS so exactly one revision-1 mutation commits', async () => {
    const store = new MemoryPluginInventoryStore();
    const controlPlane = service(store);
    await controlPlane.installPackage(candidate());

    const results = await Promise.allSettled([
      controlPlane.revokeGrant({
        pluginInstanceId: 'pi_atomic',
        capability: 'messaging.send',
        expectedGrantRevision: 1,
      }),
      controlPlane.revokeGrant({
        pluginInstanceId: 'pi_atomic',
        capability: 'onMessage',
        expectedGrantRevision: 1,
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    const snapshot = await store.snapshot();

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason?.code, 'STALE_GRANT_REVISION');
    assert.equal(snapshot.grants[0].grantRevision, 2);
    assert.equal(snapshot.grants[0].effectiveGrants.length, 1);
  });

  it('shares the durable CAS fence across file-store objects for one path', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-inventory-cas-'));
    const path = join(root, 'inventory.json');
    const first = service(new FilePluginInventoryStore(path));
    const second = service(new FilePluginInventoryStore(path));
    await first.installPackage(candidate());

    const results = await Promise.allSettled([
      first.revokeGrant({
        pluginInstanceId: 'pi_atomic',
        capability: 'messaging.send',
        expectedGrantRevision: 1,
      }),
      second.revokeGrant({
        pluginInstanceId: 'pi_atomic',
        capability: 'onMessage',
        expectedGrantRevision: 1,
      }),
    ]);
    const snapshot = await new FilePluginInventoryStore(path).snapshot();

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(snapshot.grants[0].grantRevision, 2);
    assert.equal(snapshot.grants[0].effectiveGrants.length, 1);
  });

  it('failed file commit leaves no partially durable inventory', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'plugin-inventory-atomic-'));
    const path = join(root, 'inventory.json');
    const store = new FilePluginInventoryStore(path, {
      fileOps: {
        rename: async () => {
          throw new Error('injected rename failure');
        },
      },
    });

    await assert.rejects(() => service(store).installPackage(candidate()), /injected rename failure/);
    assert.deepEqual(await new FilePluginInventoryStore(path).snapshot(), {
      schemaVersion: 1,
      packages: [],
      instances: [],
      grants: [],
    });
  });
});
