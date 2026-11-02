import assert from 'node:assert/strict';
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
const { CHATGPT_DOT_PLUGIN_MANIFEST } = await import(
  process.argv.includes('--source')
    ? '../src/domains/plugin/chatgpt-dot-manifest.ts'
    : '../dist/domains/plugin/chatgpt-dot-manifest.js'
);
const definitions = [{ catalogId: 'chatgpt-dot', manifest: CHATGPT_DOT_PLUGIN_MANIFEST }];
for (const { catalogId, manifest } of definitions) {
  assert.equal(validateManifest(manifest).valid, true, `invalid ${catalogId} manifest`);
}
await generateBundledPluginArtifacts(new URL('../dist/domains/plugin/', import.meta.url), definitions, {
  sourceRoot: new URL('../src/domains/plugin/', import.meta.url),
  check: process.argv.includes('--check'),
});
