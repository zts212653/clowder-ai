import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Capability } from '@clowder-ai/plugin-contract';
import { HostBrokerControlPlane } from '../src/domains/plugin/host-broker/control-plane.js';
import { parseHostBrokerSnapshot } from '../src/domains/plugin/host-broker/snapshot.js';
import { StaticFeatureAuthority } from '../src/domains/plugin/host-broker/static-feature-authority.js';
import { MemoryHostBrokerStore } from '../src/domains/plugin/host-broker/stores.js';
import { HostInventoryControlPlane } from '../src/domains/plugin/host-inventory/control-plane.js';
import { MemoryPluginInventoryStore } from '../src/domains/plugin/host-inventory/stores.js';
import { desktopWindowManifest } from './f317-window.fixture.js';

const digest = `sha512-${createHash('sha512').update('window fixture').digest('base64')}`;
const manifest = desktopWindowManifest();

async function fixture(grants: Capability[] = ['windows.create']) {
  const inventory = new MemoryPluginInventoryStore();
  const control = new HostInventoryControlPlane(inventory, { createInstanceId: () => 'pi_window' });
  await control.installPackage({
    manifest,
    computedPackageDigest: digest,
    expectedPackageDigest: digest,
    packagePluginId: manifest.pluginId,
    effectiveGrants: grants,
  });
  await inventory.transaction((tx) => {
    const instance = tx.instances.get('pi_window')!;
    tx.instances.put({ ...instance, configReadiness: 'ready', activationState: 'enabled' });
  });
  const store = new MemoryHostBrokerStore();
  let now = 2_000;
  const broker = new HostBrokerControlPlane({ inventory, store, now: () => now });
  const connection = await broker.openBuiltinConnection('pi_window');
  const binding = await connection.hello({
    pluginId: manifest.pluginId,
    packageDigest: digest,
    contractVersion: '0.1.0',
    wireVersion: '0.1.0',
  });
  await connection.ready({ bindingNonce: binding.bindingNonce });
  let damaged = false;
  const options = {
    inventory,
    store,
    broker,
    now: () => now,
    verifyActivePackage: async () => {
      if (damaged) throw new Error('damaged');
    },
  };
  const authority = new StaticFeatureAuthority({ ...options, admission: 'desktop-companion' });
  return {
    inventory,
    store,
    connection,
    authority,
    options,
    advance: () => {
      now += broker.activeRuntimeLeaseTtlMs + 1;
    },
    damage: () => {
      damaged = true;
    },
  };
}

test('a desktop body gets only its granted capability under the existing durable feature lease', async () => {
  const f = await fixture();
  const pending = await f.authority.begin('pi_window', 'body');
  assert.deepEqual(pending.grantedCapabilities, ['windows.create']);
  await assert.rejects(f.authority.run(pending.executionLease, async () => assert.fail('before commit')));
  const live = await f.authority.commit(pending.executionLease);
  assert.deepEqual(live.contributionIds, ['body']);
  assert.equal((await f.authority.resolve('pi_window', 'body'))?.executionLease, live.executionLease);
  const snapshot = await f.store.snapshot();
  assert.deepEqual(parseHostBrokerSnapshot(snapshot).staticFeatures?.leases[0], live);
  await f.connection.close('test');
});

test('requesting a window never substitutes for an effective grant, or broadens zero-capability editors', async () => {
  const denied = await fixture([]);
  await assert.rejects(denied.authority.begin('pi_window', 'body'), /grant|capability/i);
  const granted = await fixture();
  const editorAuthority = new StaticFeatureAuthority(granted.options);
  await assert.rejects(editorAuthority.begin('pi_window', 'body'), /authority|static|capability/i);
});

for (const reason of ['revoke', 'expire', 'damage'] as const) {
  test(`${reason} fences a desktop lease before a late visibility or bridge operation`, async () => {
    const f = await fixture();
    const lease = await f.authority.begin('pi_window', 'body');
    await f.authority.commit(lease.executionLease);
    if (reason === 'revoke')
      await f.inventory.transaction((tx) => {
        const grant = tx.grants.get('pi_window')!;
        tx.grants.put({ ...grant, grantRevision: grant.grantRevision + 1, effectiveGrants: [] });
      });
    if (reason === 'expire') f.advance();
    if (reason === 'damage') f.damage();
    await assert.rejects(f.authority.run(lease.executionLease, async () => assert.fail('late effect')));
    assert.equal(await f.authority.resolve('pi_window', 'body'), null);
    assert.equal((await f.store.snapshot()).staticFeatures?.leases[0].state, 'revoked');
  });
}

test('an editor consumer cannot use a granted window lease even when its opaque id is known', async () => {
  const f = await fixture();
  const lease = await f.authority.begin('pi_window', 'body');
  await f.authority.commit(lease.executionLease);
  await assert.rejects(
    new StaticFeatureAuthority(f.options).run(lease.executionLease, async () => assert.fail('cross class')),
  );
});
