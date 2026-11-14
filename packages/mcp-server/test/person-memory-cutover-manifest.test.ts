import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  type AtomicCutoverManifest,
  type CutoverConsumerScan,
  type CutoverSurfaceEntry,
  FIXED_CUTOVER_CONSUMER_ROOTS,
  validateAtomicCutovers,
} from '../src/tool-cutover.js';

const retired = [
  'cat_cafe_forget_person', // mcp-cutover-negative-reference: absence
  'cat_cafe_forget_person_memory_proposal', // mcp-cutover-negative-reference: absence
];
const directory = new URL('../governance/cutovers/', import.meta.url);
const manifests: AtomicCutoverManifest[] = readdirSync(directory)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(new URL(name, directory), 'utf8')) as AtomicCutoverManifest);
const after = (
  JSON.parse(readFileSync(new URL('../governance/mcp-surface-baseline.json', import.meta.url), 'utf8')) as {
    tools: CutoverSurfaceEntry[];
  }
).tools;
const previousEntries: CutoverSurfaceEntry[] = retired.map((name) => ({
  name,
  resourceFamily: 'person-memory',
  runtimeProfiles: ['full'],
}));
const scans: CutoverConsumerScan[] = [...new Set(manifests.flatMap((entry) => entry.retiredNames))].map(
  (retiredName) => ({
    retiredName,
    scannedRoots: FIXED_CUTOVER_CONSUMER_ROOTS,
    matches: [],
    negativeReferences: [],
    resolvedConsumers: [],
  }),
);

function input() {
  return structuredClone({ before: [...after, ...previousEntries], after, manifests, scans });
}

function personManifest(list: AtomicCutoverManifest[]) {
  const entry = list.find((candidate) => candidate.retiredNames.includes(retired[0]));
  assert(entry);
  return entry;
}

test('one complete person cutover covers a public baseline before both owner-page retirements', () => {
  for (const name of retired) assert(!after.some((entry) => entry.name === name));
  assert.deepEqual(validateAtomicCutovers(input()).findings, []);
});

test('the completed person cutover remains valid after the protected baseline advances', () => {
  const value = input();
  value.before = value.after;
  assert.deepEqual(validateAtomicCutovers(value).findings, []);
});

test('omitting either retirement still fails exact family coverage', () => {
  for (const name of retired) {
    const value = input();
    const entry = personManifest(value.manifests);
    entry.retiredNames = entry.retiredNames.filter((candidate) => candidate !== name);
    const result = validateAtomicCutovers(value);
    assert(!result.ok);
    assert(result.findings.some((finding) => finding.code === 'missing-cutover-manifest'));
  }
});

test('an extra retirement and a partially advanced baseline remain fail-closed', () => {
  const extra = input();
  personManifest(extra.manifests).retiredNames = [...retired, 'cat_cafe_unapproved_retirement_probe'];
  assert(validateAtomicCutovers(extra).findings.some((finding) => finding.code === 'cutover-set-mismatch'));
  const partial = input();
  partial.before = [...after, previousEntries[1]];
  assert(validateAtomicCutovers(partial).findings.some((finding) => finding.code === 'cutover-set-mismatch'));
});

test('a missing layer or missing per-name absence evidence remains blocking', () => {
  const missingLayer = input();
  delete personManifest(missingLayer.manifests).layers.observability;
  assert(validateAtomicCutovers(missingLayer).findings.some((finding) => finding.code === 'missing-cutover-layer'));
  const missingName = input();
  personManifest(missingName.manifests).layers.observability = {
    status: 'not-applicable',
    rationale: 'incomplete absence evidence',
    absenceEvidence: [retired[0]],
  };
  assert(validateAtomicCutovers(missingName).findings.some((finding) => finding.code === 'stale-retired-reference'));
});

test('stale consumers and either resurrected retired wrapper remain blocking', () => {
  const stale = input();
  const scan = stale.scans.find((entry) => entry.retiredName === retired[0]);
  assert(scan);
  scan.matches = [{ root: 'packages/api/src', path: 'packages/api/src/stale-retirement-fixture.ts', line: 1 }];
  assert(validateAtomicCutovers(stale).findings.some((finding) => finding.code === 'stale-retired-reference'));
  for (const entry of previousEntries) {
    const value = input();
    value.after.push(entry);
    assert(validateAtomicCutovers(value).findings.some((finding) => finding.code === 'cutover-set-mismatch'));
  }
});
