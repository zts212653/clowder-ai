import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { generateBundledPluginArtifacts } from './bundled-plugin-artifacts.mjs';

// Keep the existing native-build entry point. The build now owns these outputs;
// no checked-in archive, generated JSON or export-time repacking is required.
assert.ok(
  process.argv.slice(2).every((arg) => ['--check', '--source'].includes(arg)),
  'usage: copy-bundled-plugin-packages.mjs [--check] [--source]',
);
// Prepare dev artifacts from TS before starting the watcher. Production uses
// the just-compiled producer after tsc; both write the same dist layout.
const { BUNDLED_PLUGIN_DEFINITIONS: definitions } = await import(
  process.argv.includes('--source')
    ? '../src/domains/plugin/bundled-plugin-definitions.ts'
    : '../dist/domains/plugin/bundled-plugin-definitions.js'
);
const { packageCapabilityRejection } = await import(
  process.argv.includes('--source')
    ? '../src/domains/plugin/package-capability-admission.ts'
    : '../dist/domains/plugin/package-capability-admission.js'
);
const { preflightPluginArchive } = await import(
  process.argv.includes('--source')
    ? '../src/domains/plugin/external-runtime/archive-preflight.ts'
    : '../dist/domains/plugin/external-runtime/archive-preflight.js'
);
for (const { catalogId, manifest, agentProvider, prebuilt } of definitions) {
  assert.equal(validateManifest(manifest).valid, true, `invalid ${catalogId} manifest`);
  if (prebuilt) continue;
  const packageRoot = fileURLToPath(
    new URL(`../src/domains/plugin/bundled-packages/${catalogId}/${manifest.version}/`, import.meta.url),
  );
  if (agentProvider !== undefined)
    assert.ok(
      Buffer.byteLength(`${JSON.stringify(agentProvider, null, 2)}\n`) <= 65536,
      'Agent provider declaration exceeds 64 KiB',
    );
  const rejection = packageCapabilityRejection(manifest, agentProvider, packageRoot);
  assert.equal(rejection, undefined, rejection);
}
const biomeBin = fileURLToPath(new URL('../../../node_modules/@biomejs/biome/bin/biome', import.meta.url));
const formatWithBiome = (source, stdinFilePath) =>
  execFileSync(process.execPath, [biomeBin, 'format', `--stdin-file-path=${stdinFilePath}`], {
    input: source,
    encoding: 'utf8',
  });
await generateBundledPluginArtifacts(new URL('../dist/domains/plugin/', import.meta.url), definitions, {
  sourceRoot: new URL('../src/domains/plugin/', import.meta.url),
  check: process.argv.includes('--check'),
  validatePrebuiltArchive: preflightPluginArchive,
  formatManifest: (source) =>
    formatWithBiome(source, 'packages/api/src/domains/plugin/bundled-packages/plugin/manifest.json'),
});
