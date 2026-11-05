import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { managerEntryFixture } from './f317-manager-entry.fixture.js';

const detailPath = '/api/plugin-manager/plugins/official.companion';

test('production Manager composition exposes the cold Companion catalog and installs through its real HTTP entry', async (t) => {
  const f = await managerEntryFixture(t);
  assert.equal((await f.app.inject({ method: 'GET', url: detailPath })).statusCode, 401);
  const listed = await f.request('GET', '/api/plugin-manager/plugins');
  assert.equal(listed.statusCode, 200, listed.payload);
  assert.equal(listed.json().catalog.status, 'fresh');
  const row = listed.json().plugins.find((candidate) => candidate.pluginId === 'official.companion');
  assert.ok(row, 'a fresh production Manager catalog must expose Companion before installation');
  assert.equal(row.availableVersion, '0.1.0-alpha.25');
  assert.equal(row.installedVersion, null);
  assert.equal(row.actions.install, true);
  const detail = await f.request('GET', detailPath);
  assert.equal(detail.statusCode, 200, detail.payload);
  const bad = await f.request('POST', '/api/plugin-manager/plugins/install', {
    source: { kind: 'catalog', catalogId: row.source.catalogId },
    expectedVersion: row.availableVersion,
    expectedDigest: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
  });
  assert.equal(bad.statusCode, 409, bad.payload);
  assert.deepEqual(f.downloads, [], 'stale confirmation must fail before download');
  const installed = await f.request('POST', '/api/plugin-manager/plugins/install', {
    source: { kind: 'catalog', catalogId: row.source.catalogId },
    expectedVersion: row.availableVersion,
    expectedDigest: row.packageDigest,
  });
  assert.equal(installed.statusCode, 201, installed.payload);
  await f.assertVersion('0.1.0-alpha.25');
});

test('installed alpha.24 stays discoverable with alpha.25 available and upgrades through strict catalog admission', async (t) => {
  const f = await managerEntryFixture(t);
  await f.setOld(true);
  const old = f.releaseEntry();
  const installed = await f.request('POST', '/api/plugin-manager/plugins/install', {
    source: { kind: 'catalog', catalogId: old.catalogId },
    expectedVersion: old.version,
    expectedDigest: old.packageDigest,
  });
  assert.equal(installed.statusCode, 201, installed.payload);
  const original = await f.assertVersion('0.1.0-alpha.24');
  await f.setOld(false);
  const detail = await f.request('GET', detailPath);
  assert.equal(detail.statusCode, 200, detail.payload);
  assert.equal(detail.json().plugin.installedVersion, '0.1.0-alpha.24');
  assert.equal(detail.json().plugin.availableVersion, '0.1.0-alpha.25');
  const official = await f.request('GET', '/api/plugin-manager/plugins');
  const info = official.json().plugins.find((row) => row.pluginId === 'official.companion');
  assert.equal(info.availableVersion !== info.installedVersion, true);
  assert.equal(info.pluginInstanceId, original.pluginInstanceId);
  assert.equal(Object.hasOwn(info, 'installSources'), false);
  const release = f.releaseEntry();
  const upgraded = await f.request('POST', '/api/plugin-manager/plugins/install', {
    source: { kind: 'catalog', catalogId: release.catalogId },
    expectedVersion: release.version,
    expectedDigest: release.packageDigest,
  });
  assert.equal(upgraded.statusCode, 201, upgraded.payload);
  const next = await f.assertVersion('0.1.0-alpha.25');
  assert.equal(next.pluginInstanceId, original.pluginInstanceId);
});

test('Companion discovery cannot admit changed archive bytes', async (t) => {
  const f = await managerEntryFixture(t, { corrupt: true });
  const detail = await f.request('GET', detailPath);
  assert.equal(detail.statusCode, 200, detail.payload);
  const row = detail.json().plugin;
  const response = await f.request('POST', '/api/plugin-manager/plugins/install', {
    source: { kind: 'catalog', catalogId: row.source.catalogId },
    expectedVersion: row.availableVersion,
    expectedDigest: row.packageDigest,
  });
  assert.equal(response.statusCode, 422, response.payload);
  assert.equal((await f.runtime.inventoryStore.snapshot()).instances.length, 0);
});

test('main uses the same Host catalog factory and replacement authority as the production entry regression', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /const pluginManagerCatalog = createHostOfficialPluginCatalog\(\)/);
});
