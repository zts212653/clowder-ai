import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { desktopWindowContribution } from '../dist/domains/plugin/desktop-window-runtime/admission.js';
import { validateHostPluginManifest } from '../dist/domains/plugin/desktop-window-runtime/presentation-manifest.js';
import { resolveCompanionArchiveContract } from '../dist/domains/plugin/desktop-window-runtime/published-companion-v2.js';
import { managerEntryFixture, publishedLetterContract } from './f317-manager-entry.fixture.js';
import { desktopWindowManifest } from './f317-window-manifest.fixture.js';

// Exact public 7c1d369c9082fd5319f45884ee95cda5ef803e91 release rows; no mutable next tag.
const catalogData = JSON.parse(
  await readFile(new URL('./fixtures/f317-published-letter-catalog.json', import.meta.url), 'utf8'),
);
const [latestRelease, previousRelease] = catalogData.plugins[0].versions;
const latestVersion = latestRelease.version;
const previousVersion = previousRelease.version;
const fixtureOptions = { catalogData, latestVersion, previousVersion };
const detailPath = '/api/plugin-manager/plugins/official.companion';

test('published letter releases require their exact archive digests while earlier versions remain admitted', () => {
  for (const release of catalogData.plugins[0].versions) {
    const archive = {
      pluginId: 'official.companion',
      version: release.version,
      packageDigest: release.artifact.integrity,
    };
    assert.equal(resolveCompanionArchiveContract(archive), publishedLetterContract(release.version), release.version);
    for (const bad of [
      { ...archive, pluginId: 'foreign.companion' },
      { ...archive, version: '0.1.0-alpha.999' },
      { ...archive, packageDigest: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
    ])
      assert.equal(resolveCompanionArchiveContract(bad), undefined);
  }
});

test('current manifest ABI admits compatible bridge declarations while desktop execution retains its structural boundary', () => {
  const base = desktopWindowManifest(undefined, '1.3.0');
  const manifest = {
    ...base,
    pluginId: 'official.companion',
    version: latestVersion,
    contributions: base.contributions.map((row) => ({ ...row, bridgeVersion: '1.6.0' })),
  };
  // Schema compatibility is not release authenticity: the preceding test fences exact archive coordinates.
  for (const compatible of [
    manifest,
    { ...manifest, pluginId: 'foreign.companion' },
    { ...manifest, version: '0.1.0-alpha.27' },
  ]) {
    assert.equal(validateHostPluginManifest(compatible).valid, true);
  }
  assert.equal(
    validateHostPluginManifest({
      ...manifest,
      contributions: manifest.contributions.map((row) => ({ ...row, bridgeVersion: '99.0.0' })),
    }).valid,
    false,
  );
  for (const bad of [
    { ...manifest, contributions: [...manifest.contributions, { ...manifest.contributions[0], id: 'second' }] },
    { ...manifest, runtime: { transport: 'stdio', entrypoint: 'main.js' } },
  ])
    assert.equal(desktopWindowContribution(bad), undefined);
});

test('production Manager installs the current published letter and rejects a stale digest before download', async (t) => {
  const f = await managerEntryFixture(t, fixtureOptions);
  const detail = await f.request('GET', detailPath);
  assert.equal(detail.statusCode, 200, detail.payload);
  const row = detail.json().plugin;
  assert.equal(row.availableVersion, latestVersion);
  assert.equal(row.actions.install, true);
  const payload = {
    source: { kind: 'catalog', catalogId: row.source.catalogId },
    expectedVersion: row.availableVersion,
    expectedDigest: row.packageDigest,
  };
  const stale = await f.request('POST', '/api/plugin-manager/plugins/install', {
    ...payload,
    expectedDigest: catalogData.plugins[0].versions.find((row) => row.version === previousVersion).artifact.integrity,
  });
  assert.equal(stale.statusCode, 409, stale.payload);
  assert.deepEqual(f.downloads, []);
  const installed = await f.request('POST', '/api/plugin-manager/plugins/install', payload);
  assert.equal(installed.statusCode, 201, installed.payload);
  await f.assertVersion(latestVersion);
});

test('strict catalog admission upgrades the previous published letter in place without activation', async (t) => {
  const f = await managerEntryFixture(t, fixtureOptions);
  await f.setOld(true);
  const old = f.releaseEntry();
  const installed = await f.request('POST', '/api/plugin-manager/plugins/install', {
    source: { kind: 'catalog', catalogId: old.catalogId },
    expectedVersion: old.version,
    expectedDigest: old.packageDigest,
  });
  assert.equal(installed.statusCode, 201, installed.payload);
  const original = await f.assertVersion(previousVersion);
  await f.setOld(false);
  const detail = await f.request('GET', detailPath);
  assert.equal(detail.statusCode, 200, detail.payload);
  assert.equal(detail.json().plugin.installedVersion, previousVersion);
  assert.equal(detail.json().plugin.availableVersion, latestVersion);
  const listed = await f.request('GET', '/api/plugin-manager/plugins');
  const info = listed.json().plugins.find((row) => row.pluginId === 'official.companion');
  assert.equal(info.availableVersion !== info.installedVersion, true);
  assert.equal(Object.hasOwn(info, 'installSources'), false);
  const release = f.releaseEntry();
  const upgraded = await f.request('POST', '/api/plugin-manager/plugins/install', {
    source: { kind: 'catalog', catalogId: release.catalogId },
    expectedVersion: release.version,
    expectedDigest: release.packageDigest,
  });
  assert.equal(upgraded.statusCode, 201, upgraded.payload);
  assert.equal((await f.assertVersion(latestVersion)).pluginInstanceId, original.pluginInstanceId);
});

test('production Manager rejects changed current archive bytes with no installed instance', async (t) => {
  const f = await managerEntryFixture(t, { ...fixtureOptions, corrupt: true });
  const detail = await f.request('GET', detailPath);
  assert.equal(detail.statusCode, 200, detail.payload);
  const row = detail.json().plugin;
  const rejected = await f.request('POST', '/api/plugin-manager/plugins/install', {
    source: { kind: 'catalog', catalogId: row.source.catalogId },
    expectedVersion: row.availableVersion,
    expectedDigest: row.packageDigest,
  });
  assert.equal(rejected.statusCode, 422, rejected.payload);
  assert.equal((await f.runtime.inventoryStore.snapshot()).instances.length, 0);
});
