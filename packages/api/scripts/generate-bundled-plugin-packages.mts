import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { CHATGPT_DOT_PLUGIN_MANIFEST } from '../src/domains/plugin/chatgpt-dot-manifest.js';
import { generateBundledPluginArtifacts } from './bundled-plugin-artifacts.mjs';

const definitions = [{ catalogId: 'chatgpt-dot', manifest: CHATGPT_DOT_PLUGIN_MANIFEST }];
for (const { catalogId, manifest } of definitions) {
  assert.equal(validateManifest(manifest).valid, true, `invalid ${catalogId} manifest`);
}
await generateBundledPluginArtifacts(new URL('../src/domains/plugin/', import.meta.url), definitions, {
  check: process.argv.includes('--check'),
  formatIndex: (source: string) =>
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL('../../../node_modules/@biomejs/biome/bin/biome', import.meta.url)),
        'format',
        '--stdin-file-path=packages/api/src/domains/plugin/bundled-package-index.ts',
      ],
      { input: source, encoding: 'utf8' },
    ),
});
