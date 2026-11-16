import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type AtomicCutoverManifest, type CutoverSurfaceEntry, validateAtomicCutovers } from '../src/tool-cutover.js';
import { scanRetiredNames } from '../src/tool-cutover-consumer-scan.js';

const directory = new URL('../governance/cutovers/', import.meta.url);
const manifests = readdirSync(directory)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(new URL(name, directory), 'utf8')) as AtomicCutoverManifest);
// All 190 actual public name/family/profile entries, not a reconstruction from after.
const publicProjection = JSON.parse(
  readFileSync(new URL('history/memory-read-find-public-190-projection.json', directory), 'utf8'),
) as { beforeCount: number; tools: CutoverSurfaceEntry[]; removedEntries: CutoverSurfaceEntry[] };
const after = (
  JSON.parse(readFileSync(new URL('../governance/mcp-surface-baseline.json', import.meta.url), 'utf8')) as {
    tools: CutoverSurfaceEntry[];
  }
).tools;
const scans = await scanRetiredNames(
  fileURLToPath(new URL('../../..', import.meta.url)),
  manifests.flatMap((manifest) => manifest.retiredNames),
);
const input = { before: publicProjection.tools, after, manifests, scans };

test('real public baseline crosses read and find cutovers with the complete fixed-root scan', () => {
  assert.equal(publicProjection.tools.length, publicProjection.beforeCount);
  assert.equal(publicProjection.removedEntries.length, 6);
  for (const entry of publicProjection.removedEntries) {
    assert(!after.some((tool) => tool.name === entry.name));
  }
  assert.deepEqual(validateAtomicCutovers(input).findings, []);
});

test('cumulative read/find evidence also validates a source baseline with no current delta', () => {
  assert.deepEqual(validateAtomicCutovers({ ...input, before: after }).findings, []);
});

test('cumulative evidence cannot omit a retired identity or accept an unrecorded family retirement', () => {
  const index = manifests.findIndex((manifest) => manifest.canonicalNames.includes('cat_cafe_read_memory'));
  assert(index >= 0);
  const incomplete = manifests.map((manifest, entryIndex) =>
    entryIndex === index ? { ...manifest, retiredNames: manifest.retiredNames.slice(1) } : manifest,
  );
  assert(
    validateAtomicCutovers({ ...input, manifests: incomplete }).findings.some(
      (finding) => finding.code === 'cutover-set-mismatch',
    ),
  );
  const unrecorded = { ...publicProjection.removedEntries[0], name: 'cat_cafe_unrecorded_retirement' };
  assert(
    validateAtomicCutovers({ ...input, before: [...input.before, unrecorded] }).findings.some(
      (finding) => finding.code === 'cutover-set-mismatch',
    ),
  );
});
