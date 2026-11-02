import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { generateBundledPluginArtifacts } from '../scripts/bundled-plugin-artifacts.mjs';
import { bundledBuildFixture } from './helpers/bundled-plugin-build-fixture.js';

test('the bundled producer includes the ACP declaration in the exact package bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bundled-acp-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'bundled-packages/codeagent/0.1.0/assets'), { recursive: true });
  await writeFile(join(root, 'bundled-packages/codeagent/0.1.0/assets/icon.svg'), '<svg/>');
  const declaration = { id: 'codeagent', transport: 'acp', acp: { command: 'codeagent', startupArgs: ['--acp'] } };
  const definitions = [
    {
      catalogId: 'codeagent',
      agentProvider: declaration,
      manifest: { pluginId: 'official.codeagent', version: '0.1.0', icon: { src: 'assets/icon.svg' } },
    },
  ];
  const url = pathToFileURL(`${root}/`);
  await generateBundledPluginArtifacts(url, definitions);
  const archive = await readFile(join(root, 'bundled-packages/codeagent/0.1.0/package.tgz'));
  assert.ok(
    gunzipSync(archive).includes(Buffer.from('package/agent-provider.json\0')),
    'the installed archive must carry its declaration',
  );
  assert.ok(gunzipSync(archive).includes(Buffer.from(JSON.stringify(declaration, null, 2))));
  await generateBundledPluginArtifacts(url, definitions, { check: true });
  assert.deepEqual(await readFile(join(root, 'bundled-packages/codeagent/0.1.0/package.tgz')), archive);
});

for (const fromSource of [false, true]) {
  test(`build and check apply the same ACP admission before publishing (source=${fromSource})`, async (t) => {
    const f = await bundledBuildFixture(t, 'Fixture', fromSource);
    const definitionPath = join(
      f.root,
      fromSource ? 'src' : 'dist',
      'domains/plugin',
      `bundled-plugin-definitions.${fromSource ? 'ts' : 'js'}`,
    );
    const manifest = {
      pluginId: 'example.fixture-agent',
      version: '1.0.0',
      contractVersion: '0.1.0',
      name: 'Fixture',
      features: [{ id: 'agent', name: 'Agent', resources: [], capabilities: [] }],
    };
    const definition = {
      catalogId: 'fixture-agent',
      manifest,
      agentProvider: {
        id: 'agent',
        transport: 'acp',
        acp: { command: 'external-agent', startupArgs: ['--acp'] },
      },
    };
    const writeDefinitions = (value) =>
      writeFile(definitionPath, `export const BUNDLED_PLUGIN_DEFINITIONS = ${JSON.stringify([value])};\n`);
    await writeDefinitions(definition);
    const built = f.build();
    assert.equal(built.status, 0, built.stderr);
    const archivePath = join(f.pluginRoot, 'bundled-packages/fixture-agent/1.0.0/package.tgz');
    const before = await readFile(archivePath);
    assert.ok(gunzipSync(before).includes(Buffer.from('package/agent-provider.json\0')));
    assert.equal(f.build('--check').status, 0);
    await writeDefinitions({ catalogId: definition.catalogId, manifest });
    const invalid = f.build();
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /valid ACP declaration/);
    assert.deepEqual(await readFile(archivePath), before, 'invalid input must not replace previous output');
    assert.notEqual(f.build('--check').status, 0);
    assert.deepEqual(await readFile(archivePath), before, 'check must remain read-only');
  });
}
