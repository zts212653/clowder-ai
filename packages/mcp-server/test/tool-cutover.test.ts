import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  type AtomicCutoverManifest,
  type CutoverConsumerScan,
  type CutoverSurfaceEntry,
  FIXED_CUTOVER_CONSUMER_ROOTS,
  REQUIRED_CUTOVER_LAYERS,
  validateAtomicCutovers,
} from '../src/tool-cutover.js';

const oldEntry: CutoverSurfaceEntry = {
  name: 'cat_cafe_subject_old',
  resourceFamily: 'subject',
  runtimeProfiles: ['full', 'readonly'],
};

const newEntry: CutoverSurfaceEntry = {
  name: 'cat_cafe_subject',
  resourceFamily: 'subject',
  runtimeProfiles: ['full', 'readonly'],
};

function cleanScan(retiredName = oldEntry.name): CutoverConsumerScan {
  return {
    retiredName,
    scannedRoots: FIXED_CUTOVER_CONSUMER_ROOTS,
    matches: [],
    resolvedConsumers: [],
  };
}

function manifest(overrides: Partial<AtomicCutoverManifest> = {}): AtomicCutoverManifest {
  return {
    resource: { kind: 'family', resourceFamily: 'subject' },
    retiredNames: [oldEntry.name],
    canonicalNames: [newEntry.name],
    expectedProfiles: {
      [newEntry.name]: ['full', 'readonly'],
    },
    rollbackRevision: 'a'.repeat(40),
    layers: Object.fromEntries(
      REQUIRED_CUTOVER_LAYERS.map((layer) => [
        layer,
        { status: 'not-applicable', rationale: 'fixed-root scan is empty', absenceEvidence: [oldEntry.name] },
      ]),
    ) as AtomicCutoverManifest['layers'],
    ...overrides,
  };
}

describe('F286 atomic cutover guard', () => {
  it('requires a manifest for every semantic removal', () => {
    const result = validateAtomicCutovers({
      before: [oldEntry],
      after: [],
      manifests: [],
      scans: [cleanScan()],
    });

    assert.equal(result.ok, false);
    assert.ok(result.findings.some((finding) => finding.code === 'missing-cutover-manifest'));
  });

  it('requires a manifest whose expected profiles exactly cover every projection removal', () => {
    const after = { ...oldEntry, runtimeProfiles: ['full'] as const };
    const missing = validateAtomicCutovers({
      before: [oldEntry],
      after: [after],
      manifests: [],
      scans: [],
    });
    assert.ok(missing.findings.some((finding) => finding.code === 'missing-cutover-manifest'));

    const exact = validateAtomicCutovers({
      before: [oldEntry],
      after: [after],
      manifests: [manifest({ retiredNames: [], canonicalNames: [], expectedProfiles: { [oldEntry.name]: ['full'] } })],
      scans: [],
    });
    assert.deepEqual(exact.findings, []);

    const omitted = validateAtomicCutovers({
      before: [oldEntry],
      after: [after],
      manifests: [manifest({ retiredNames: [], canonicalNames: [], expectedProfiles: {} })],
      scans: [],
    });
    assert.ok(omitted.findings.some((finding) => finding.code === 'cutover-set-mismatch'));
  });

  it('accepts one exact family cutover with complete empty-consumer evidence', () => {
    const result = validateAtomicCutovers({
      before: [oldEntry],
      after: [newEntry],
      manifests: [manifest()],
      scans: [cleanScan()],
    });

    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
  });

  it('rejects a manifest whose old/new sets do not exactly cover the derived delta', () => {
    const result = validateAtomicCutovers({
      before: [oldEntry],
      after: [newEntry],
      manifests: [manifest({ retiredNames: ['cat_cafe_unrelated_old'] })],
      scans: [cleanScan()],
    });

    assert.ok(result.findings.some((finding) => finding.code === 'cutover-set-mismatch'));
  });

  it('rejects an omitted layer and author-narrowed consumer roots', () => {
    const incompleteLayers = { ...manifest().layers };
    delete incompleteLayers.observability;
    const result = validateAtomicCutovers({
      before: [oldEntry],
      after: [newEntry],
      manifests: [manifest({ layers: incompleteLayers })],
      scans: [{ ...cleanScan(), scannedRoots: ['packages/mcp-server/src'] }],
    });

    assert.ok(result.findings.some((finding) => finding.code === 'missing-cutover-layer'));
    assert.ok(result.findings.some((finding) => finding.code === 'consumer-root-coverage-mismatch'));
  });

  it('rejects stale production, prompt, skill, eval, or observability consumers', () => {
    const result = validateAtomicCutovers({
      before: [oldEntry],
      after: [newEntry],
      manifests: [manifest()],
      scans: [
        {
          ...cleanScan(),
          matches: [{ root: 'cat-cafe-skills', path: 'cat-cafe-skills/example/SKILL.md', line: 12 }],
        },
      ],
    });

    assert.ok(result.findings.some((finding) => finding.code === 'stale-retired-reference'));
  });

  it('rejects unrelated families unless an evidenced tightly-coupled group is declared', () => {
    const other: CutoverSurfaceEntry = {
      name: 'cat_cafe_other_old',
      resourceFamily: 'other',
      runtimeProfiles: ['full'],
    };
    const result = validateAtomicCutovers({
      before: [oldEntry, other],
      after: [newEntry],
      manifests: [manifest({ retiredNames: [oldEntry.name, other.name] })],
      scans: [cleanScan(), cleanScan(other.name)],
    });

    assert.ok(result.findings.some((finding) => finding.code === 'cross-family-cutover'));
  });

  it('requires an exact immutable rollback revision', () => {
    const result = validateAtomicCutovers({
      before: [oldEntry],
      after: [newEntry],
      manifests: [manifest({ rollbackRevision: 'main' })],
      scans: [cleanScan()],
    });

    assert.ok(result.findings.some((finding) => finding.code === 'invalid-rollback-revision'));
  });

  it('rejects any profile that still exposes a retired and canonical name together', () => {
    const result = validateAtomicCutovers({
      before: [oldEntry],
      after: [oldEntry, newEntry],
      manifests: [manifest()],
      scans: [cleanScan()],
    });

    assert.ok(result.findings.some((finding) => finding.code === 'dual-surface-exposure'));
  });
});
