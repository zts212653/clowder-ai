import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { GovernanceRegistry } from '../../dist/config/governance/governance-registry.js';

const root = process.argv[2];
const originalRead = fs.readFile;
let reads = 0;
let bytes = 0;
let peakHeap = process.memoryUsage().heapUsed;
let peakExternal = process.memoryUsage().external;
fs.readFile = async function (...args) {
  const value = await Reflect.apply(originalRead, this, args);
  if (String(args[0]).startsWith(root)) {
    reads++;
    bytes += typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength;
    const memory = process.memoryUsage();
    peakHeap = Math.max(peakHeap, memory.heapUsed);
    peakExternal = Math.max(peakExternal, memory.external);
  }
  return value;
};
syncBuiltinESMExports();
const started = performance.now();
const registry = new GovernanceRegistry(root);
// The legacy mode is only for the isolated RED diagnostic, never the passing regression.
const health =
  process.argv[3] === '--legacy'
    ? await Promise.all((await registry.listAll()).map((entry) => registry.checkHealth(entry.projectPath)))
    : await registry.listHealth();
assert.equal(health.length, 1001);
assert.equal(reads, 1, 'one registry snapshot per health query');
for (const [index, entry] of health.entries()) {
  assert.equal(entry.projectPath, `/private/var/folders/synthetic-${index}/setup-fixture-${'x'.repeat(42)}/project`);
  assert.equal(entry.status, index % 2 ? 'stale' : 'healthy');
  assert.equal(entry.lastSyncedAt, 1791497228000 + index);
  assert.deepEqual(entry.findings, []);
}
console.log(
  JSON.stringify({
    results: health.length,
    reads,
    bytes,
    peakHeap,
    peakExternal,
    elapsedMs: performance.now() - started,
  }),
);
