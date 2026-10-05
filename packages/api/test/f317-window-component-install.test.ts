import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { HostInventoryControlPlane } from '../src/domains/plugin/host-inventory/control-plane.js';
import { OfficialPluginPackageInstaller } from '../src/domains/plugin/official-package-installer.js';
import { desktopWindowFixture, windowHtml } from './f317-window.fixture.js';

test('Host admits the published companion bridge 1.3 contract without expanding its grant', async (t) => {
  const f = await desktopWindowFixture(windowHtml, undefined, '1.3.0');
  t.after(f.cleanup);
  const installer = new OfficialPluginPackageInstaller({
    inventory: new HostInventoryControlPlane(f.store),
    packagesRoot: join(f.root, 'cache'),
    catalog: [f.entry],
    fetchArchive: async () => f.bytes,
  });
  const installed = await installer.install(f.entry.catalogId, f.entry);
  const snapshot = await f.store.snapshot();
  assert.equal(snapshot.instances[0].pluginInstanceId, installed.pluginInstanceId);
  assert.deepEqual(snapshot.grants[0].effectiveGrants, ['windows.create']);
});

test('verified companion installation prepares the Host component; reinstall can repair it without changing inventory', async (t) => {
  const f = await desktopWindowFixture();
  t.after(f.cleanup);
  let prepared = 0;
  const installer = new OfficialPluginPackageInstaller({
    inventory: new HostInventoryControlPlane(f.store),
    packagesRoot: join(f.root, 'cache'),
    catalog: [f.entry],
    fetchArchive: async () => f.bytes,
    prepareDesktopComponent: async () => {
      prepared++;
    },
  });
  const installed = await installer.install(f.entry.catalogId, f.entry);
  assert.equal(prepared, 1);
  assert.deepEqual(await installer.install(f.entry.catalogId, f.entry), installed);
  assert.equal(prepared, 2);
});
test('ungranted or corrupt companion packages cannot trigger desktop component preparation', async (t) => {
  const f = await desktopWindowFixture();
  t.after(f.cleanup);
  let prepared = 0;
  const entry = { ...f.entry, effectiveGrants: [] };
  const installer = new OfficialPluginPackageInstaller({
    inventory: new HostInventoryControlPlane(f.store),
    packagesRoot: join(f.root, 'cache'),
    catalog: [entry],
    fetchArchive: async () => f.bytes,
    prepareDesktopComponent: async () => {
      prepared++;
    },
  });
  await installer.install(entry.catalogId, entry);
  assert.equal(prepared, 0);
  const corrupt = new OfficialPluginPackageInstaller({
    inventory: new HostInventoryControlPlane(f.store),
    packagesRoot: join(f.root, 'cache'),
    catalog: [f.entry],
    fetchArchive: async () => new Uint8Array([1, 2, 3]),
    prepareDesktopComponent: async () => {
      prepared++;
    },
  });
  await assert.rejects(corrupt.install(f.entry.catalogId, f.entry));
  assert.equal(prepared, 0);
});
