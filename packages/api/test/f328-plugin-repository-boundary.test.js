import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createHostOfficialPluginCatalog } from '../dist/domains/plugin/manager/host-official-catalog.js';

// Candidate metadata is a contract fixture, not a claim that this version is published.
function catalogFixture() {
  const catalog = JSON.parse(readFileSync(new URL('./fixtures/f317-manager-companion-catalog.json', import.meta.url)));
  const plugin = catalog.plugins[0];
  plugin.pluginId = 'official.tripo-studio';
  plugin.name = 'Tripo Studio';
  plugin.versions = [plugin.versions[0]];
  const release = plugin.versions[0];
  release.version = '0.1.7';
  release.artifact.version = release.version;
  release.artifact.packageName = '@clowder-ai/tripo-studio';
  release.artifact.tarballUrl = 'https://registry.npmjs.org/@clowder-ai/tripo-studio/-/tripo-studio-0.1.7.tgz';
  release.artifact.provenance.sourceDirectory = 'packages/tripo-studio';
  return catalog;
}

test('Tripo discovery consumes exact plugin-repository release metadata with no Host grants', async () => {
  const fixture = catalogFixture();
  const catalog = createHostOfficialPluginCatalog(async () => fixture);
  const snapshot = await catalog.snapshot();
  assert.equal(snapshot.status, 'fresh');
  const entry = snapshot.entries.find((candidate) => candidate.pluginId === 'official.tripo-studio');
  assert.ok(entry);
  assert.equal(entry.distribution, 'registry');
  assert.equal(entry.packageName, '@clowder-ai/tripo-studio');
  assert.equal(entry.version, fixture.plugins[0].versions[0].version);
  assert.equal(entry.packageDigest, fixture.plugins[0].versions[0].artifact.integrity);
  assert.deepEqual(entry.effectiveGrants, []);
});

test('catalog absence cannot manufacture a bundled Tripo release or hide the remaining Host bundle', async () => {
  const catalog = createHostOfficialPluginCatalog(async () => ({ schemaVersion: '1', plugins: [] }));
  const snapshot = await catalog.snapshot();
  assert.equal(
    snapshot.entries.some((candidate) => candidate.pluginId === 'official.tripo-studio'),
    false,
  );
  assert.equal(
    snapshot.entries.some((candidate) => candidate.pluginId === 'official.collective-connector'),
    false,
  );
  for (const id of ['official.chatgpt-dot']) {
    assert.ok(snapshot.entries.some((candidate) => candidate.pluginId === id));
  }
});
