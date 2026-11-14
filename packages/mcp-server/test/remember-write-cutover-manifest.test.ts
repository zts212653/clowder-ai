import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  type AtomicCutoverManifest,
  type CutoverSurfaceEntry,
  FIXED_CUTOVER_CONSUMER_ROOTS,
  validateAtomicCutovers,
} from '../src/tool-cutover.js';

const directory = new URL('../governance/cutovers/', import.meta.url);
const manifests = readdirSync(directory)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(new URL(name, directory), 'utf8')) as AtomicCutoverManifest);
const after = (
  JSON.parse(readFileSync(new URL('../governance/mcp-surface-baseline.json', import.meta.url), 'utf8')) as {
    tools: CutoverSurfaceEntry[];
  }
).tools;
// Exact removed name/family/profile projection from public 1ac5dfe475's 199-tool baseline.
// Reuse the unchanged common surface to isolate cumulative retirement-manifest coverage.
const { removedEntries } = JSON.parse(
  readFileSync(new URL('history/remember-write-public-199-projection.json', directory), 'utf8'),
) as { removedEntries: CutoverSurfaceEntry[] };

test('checked-in manifests cover both memory-write retirement phases against the real public baseline', () => {
  assert.equal(removedEntries.length, 8);
  for (const entry of removedEntries) assert(!after.some((tool) => tool.name === entry.name));
  const input = {
    before: [...after, ...removedEntries],
    after,
    manifests,
    scans: [...new Set(manifests.flatMap((manifest) => manifest.retiredNames))].map((retiredName) => ({
      retiredName,
      scannedRoots: FIXED_CUTOVER_CONSUMER_ROOTS,
      matches: [],
      negativeReferences: [],
      resolvedConsumers: [],
    })),
  };
  assert.deepEqual(validateAtomicCutovers(input).findings, []);
  assert.deepEqual(validateAtomicCutovers({ ...input, before: after }).findings, []);
});
