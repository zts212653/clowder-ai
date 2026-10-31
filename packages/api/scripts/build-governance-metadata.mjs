import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileGovernanceL0FromMarkdown } from '../dist/domains/cats/services/context/governance-l0.js';

// Build provenance only: runtime continues to compile the canonical rules and
// apply its existing overlays. No test source or private absolute path is emitted.
assert.ok(
  process.argv.slice(2).every((arg) => arg === '--check'),
  'usage: build-governance-metadata.mjs [--check]',
);
const source = new URL('../../../cat-cafe-skills/refs/shared-rules.md', import.meta.url);
const target = new URL('../dist/domains/cats/services/context/governance-build.json', import.meta.url);
const rules = await readFile(source, 'utf8');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const bytes = `${JSON.stringify(
  {
    schemaVersion: 1,
    source: 'cat-cafe-skills/refs/shared-rules.md',
    sourceSha256: sha256(rules),
    compiledSha256: sha256(compileGovernanceL0FromMarkdown(rules)),
  },
  null,
  2,
)}\n`;
if (process.argv.includes('--check')) {
  assert.equal(await readFile(target, 'utf8'), bytes, 'governance inputs changed; rebuild the API');
} else {
  await mkdir(dirname(fileURLToPath(target)), { recursive: true });
  await writeFile(target, bytes);
}
