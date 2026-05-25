import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { resolveA2aEvidenceBundle } from '../../dist/infrastructure/harness-eval/eval-a2a-artifact-resolver.js';

const verdictId = '2026-05-22-eval-a2a-live-verdict';

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createBundle(overrides = {}) {
  const bundleDir = mkdtempSync(join(tmpdir(), 'f192-a2a-bundle-'));
  const snapshot = {
    verdictId,
    evalSnapshotId: 'eval-F167-2026-05-22',
    featureId: 'F167',
    generatedAt: '2026-05-22T18:00:00.000Z',
    window: { startMs: 1779430000000, endMs: 1779516400000, durationHours: 24 },
    components: [
      {
        id: 'C2',
        name: 'forced-pass guard',
        activationCounts: { 'c2.verdict_hint_emitted': 20 },
        frictionCounts: { 'c2.verdict_without_pass_count': 9 },
        confidence: 'medium',
      },
    ],
    ...(overrides.snapshot ?? {}),
  };
  const attribution = {
    verdictId,
    featureId: 'F167',
    evalSnapshotId: 'eval-F167-2026-05-22',
    generatedAt: '2026-05-22T18:01:00.000Z',
    findings: [
      {
        id: 'AR-2026-05-22-001',
        relatedFeature: 'F167',
        frictionSignal: {
          type: 'c2.verdict_without_pass_count',
          severity: 'medium',
          confidence: 0.7,
          detectedAt: '2026-05-22T18:01:00.000Z',
        },
        attribution: {
          primaryLayer: 'harness_misfit',
          evidence: [
            {
              type: 'counter',
              anchor: 'C2/c2.verdict_without_pass_count',
              excerpt: 'c2.verdict_without_pass_count=9 exceeds threshold',
            },
          ],
        },
        proposedAction: [{ action: 'harness-tune', target: 'C2', rationale: 'forced-pass hint rate is high' }],
        status: 'open',
      },
    ],
    ...(overrides.attribution ?? {}),
  };
  const provenance = {
    verdictId,
    rawInputs: [
      {
        path: 'docs/harness-feedback/snapshots/2026-05-22-F167-eval.yaml',
        sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      {
        path: 'docs/harness-feedback/attributions/2026-05-22-F167-attribution.yaml',
        sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    ],
    generatedAt: '2026-05-22T18:02:00.000Z',
    generator: { name: 'eval-a2a-live-verdict', version: '1' },
    sanitizeRulesVersion: 'f192-e-pilot-v1',
    ...(overrides.provenance ?? {}),
  };

  writeJson(join(bundleDir, 'snapshot.json'), snapshot);
  writeJson(join(bundleDir, 'attribution.json'), attribution);
  writeJson(join(bundleDir, 'provenance.json'), provenance);
  return bundleDir;
}

describe('eval:a2a evidence bundle resolver', () => {
  it('loads a committed bundle and maps snapshot / attribution subset to adapter input shape', () => {
    const bundleDir = createBundle();

    const resolved = resolveA2aEvidenceBundle({ bundleDir, verdictId });

    assert.equal(resolved.verdictId, verdictId);
    assert.equal(resolved.snapshotRef, `snapshot:bundle/${verdictId}/snapshot`);
    assert.deepEqual(resolved.attributionRefs, [`attribution:bundle/${verdictId}/AR-2026-05-22-001`]);
    assert.equal(resolved.snapshot.components[0].componentId, 'C2');
    assert.equal(resolved.snapshot.components[0].componentName, 'forced-pass guard');
    assert.equal(resolved.attributionReport.findings[0].id, 'AR-2026-05-22-001');
    assert.equal(resolved.provenance.rawInputs.length, 2);
  });

  it('accepts no-data confidence for bundled components from telemetry-gap snapshots', () => {
    const bundleDir = createBundle({
      snapshot: {
        components: [
          {
            id: 'C2',
            name: 'forced-pass guard',
            activationCounts: { 'c2.verdict_hint_emitted': null },
            frictionCounts: { 'c2.verdict_without_pass_count': null },
            confidence: 'no-data',
          },
        ],
      },
    });

    const resolved = resolveA2aEvidenceBundle({ bundleDir, verdictId });

    assert.equal(resolved.snapshot.components[0].confidence, 'no-data');
  });

  it('accepts zero-hour snapshot windows from empty trace stores', () => {
    const bundleDir = createBundle({
      snapshot: {
        window: { startMs: 1779516400000, endMs: 1779516400000, durationHours: 0 },
      },
    });

    const resolved = resolveA2aEvidenceBundle({ bundleDir, verdictId });

    assert.equal(resolved.snapshot.window.durationHours, 0);
  });

  it('rejects refs that point at raw runtime snapshot or attribution paths', () => {
    const bundleDir = createBundle();

    assert.throws(
      () =>
        resolveA2aEvidenceBundle({
          bundleDir,
          verdictId,
          snapshotRef: 'snapshot:docs/harness-feedback/snapshots/2026-05-22-F167-eval.yaml',
        }),
      /snapshot ref must resolve to committed bundle/,
    );
  });

  it('rejects bundle files whose verdict id does not match the requested verdict', () => {
    const bundleDir = createBundle({ provenance: { verdictId: 'other-verdict' } });

    assert.throws(() => resolveA2aEvidenceBundle({ bundleDir, verdictId }), /bundle verdict id mismatch/);
  });

  it('rejects attribution evidence anchors that do not match any bundled snapshot component', () => {
    const bundleDir = createBundle({
      attribution: {
        findings: [
          {
            id: 'AR-2026-05-22-001',
            relatedFeature: 'F167',
            frictionSignal: {
              type: 'c2.verdict_without_pass_count',
              severity: 'medium',
              confidence: 0.7,
              detectedAt: '2026-05-22T18:01:00.000Z',
            },
            attribution: {
              primaryLayer: 'harness_misfit',
              evidence: [{ type: 'counter', anchor: 'C9/missing', excerpt: 'counter points at a missing component' }],
            },
            proposedAction: [{ action: 'harness-tune', target: 'C9', rationale: 'bad component ref' }],
            status: 'open',
          },
        ],
      },
    });

    assert.throws(
      () => resolveA2aEvidenceBundle({ bundleDir, verdictId }),
      /attribution evidence anchor does not match bundled snapshot components/,
    );
  });

  it('rejects attribution evidence anchors whose metric is absent from the bundled snapshot component', () => {
    const bundleDir = createBundle({
      attribution: {
        findings: [
          {
            id: 'AR-2026-05-22-001',
            relatedFeature: 'F167',
            frictionSignal: {
              type: 'c2.missing_metric',
              severity: 'medium',
              confidence: 0.7,
              detectedAt: '2026-05-22T18:01:00.000Z',
            },
            attribution: {
              primaryLayer: 'harness_misfit',
              evidence: [
                {
                  type: 'counter',
                  anchor: 'C2/c2.missing_metric',
                  excerpt: 'counter points at a metric missing from the component bundle',
                },
              ],
            },
            proposedAction: [{ action: 'harness-tune', target: 'C2', rationale: 'bad metric ref' }],
            status: 'open',
          },
        ],
      },
    });

    assert.throws(
      () => resolveA2aEvidenceBundle({ bundleDir, verdictId }),
      /attribution evidence anchor does not match bundled snapshot metrics/,
    );
  });

  it('accepts telemetry-gap anchors for missing counters on bundled components', () => {
    const bundleDir = createBundle({
      attribution: {
        findings: [
          {
            id: 'AR-2026-05-22-001',
            relatedFeature: 'F167',
            frictionSignal: {
              type: 'observability-gap',
              severity: 'medium',
              confidence: 0.9,
              detectedAt: '2026-05-22T18:01:00.000Z',
            },
            attribution: {
              primaryLayer: 'tool_gap',
              evidence: [
                {
                  type: 'telemetry-gap',
                  anchor: 'C2/c2.missing_counter',
                  excerpt: 'missing counter should be added to make the harness observable',
                },
              ],
            },
            proposedAction: [{ action: 'add-counter', target: 'C2/c2.missing_counter', rationale: 'instrument gap' }],
            status: 'open',
          },
        ],
      },
    });

    const resolved = resolveA2aEvidenceBundle({ bundleDir, verdictId });

    assert.equal(resolved.attributionReport.findings[0].attribution.evidence[0].type, 'telemetry-gap');
  });

  it('rejects component evidence anchors that omit the metric key', () => {
    for (const anchor of ['C2', 'C2/']) {
      const bundleDir = createBundle({
        attribution: {
          findings: [
            {
              id: 'AR-2026-05-22-001',
              relatedFeature: 'F167',
              frictionSignal: {
                type: 'c2.verdict_without_pass_count',
                severity: 'medium',
                confidence: 0.7,
                detectedAt: '2026-05-22T18:01:00.000Z',
              },
              attribution: {
                primaryLayer: 'harness_misfit',
                evidence: [{ type: 'counter', anchor, excerpt: 'component evidence omits metric key' }],
              },
              proposedAction: [{ action: 'harness-tune', target: 'C2', rationale: 'bad component-only ref' }],
              status: 'open',
            },
          ],
        },
      });

      assert.throws(
        () => resolveA2aEvidenceBundle({ bundleDir, verdictId }),
        /attribution evidence anchor must include a metric key/,
      );
    }
  });

  it('rejects non-C component-style anchors that are not backed by bundled snapshot data', () => {
    const bundleDir = createBundle({
      attribution: {
        findings: [
          {
            id: 'AR-2026-05-22-001',
            relatedFeature: 'F167',
            frictionSignal: {
              type: 'c2.verdict_without_pass_count',
              severity: 'medium',
              confidence: 0.7,
              detectedAt: '2026-05-22T18:01:00.000Z',
            },
            attribution: {
              primaryLayer: 'harness_misfit',
              evidence: [
                {
                  type: 'counter',
                  anchor: 'C2/c2.verdict_without_pass_count',
                  excerpt: 'component counter resolves to the bundle snapshot',
                },
                {
                  type: 'counter',
                  anchor: 'route-serial/missing_metric',
                  excerpt: 'non-C component-style anchor points at missing bundled evidence',
                },
              ],
            },
            proposedAction: [{ action: 'harness-tune', target: 'C2', rationale: 'bad mixed evidence ref' }],
            status: 'open',
          },
        ],
      },
    });

    assert.throws(
      () => resolveA2aEvidenceBundle({ bundleDir, verdictId }),
      /attribution evidence anchor does not match bundled snapshot components/,
    );
  });

  it('accepts global evidence anchors when the finding also has a valid bundled component metric anchor', () => {
    const bundleDir = createBundle({
      attribution: {
        findings: [
          {
            id: 'AR-2026-05-22-001',
            relatedFeature: 'F167',
            frictionSignal: {
              type: 'c2.verdict_without_pass_count',
              severity: 'medium',
              confidence: 0.7,
              detectedAt: '2026-05-22T18:01:00.000Z',
            },
            attribution: {
              primaryLayer: 'harness_misfit',
              evidence: [
                {
                  type: 'snapshot',
                  anchor: 'snapshot:global-friction-total',
                  excerpt: 'global friction total exceeded threshold',
                },
                {
                  type: 'counter',
                  anchor: 'C2/c2.verdict_without_pass_count',
                  excerpt: 'component counter resolves to the bundle snapshot',
                },
              ],
            },
            proposedAction: [{ action: 'harness-tune', target: 'C2', rationale: 'component metric resolves' }],
            status: 'open',
          },
        ],
      },
    });

    const resolved = resolveA2aEvidenceBundle({ bundleDir, verdictId });

    assert.deepEqual(resolved.attributionRefs, [`attribution:bundle/${verdictId}/AR-2026-05-22-001`]);
  });

  it('rejects findings whose evidence has no bundled component anchor', () => {
    const bundleDir = createBundle({
      attribution: {
        findings: [
          {
            id: 'AR-2026-05-22-001',
            relatedFeature: 'F167',
            frictionSignal: {
              type: 'c2.verdict_without_pass_count',
              severity: 'medium',
              confidence: 0.7,
              detectedAt: '2026-05-22T18:01:00.000Z',
            },
            attribution: {
              primaryLayer: 'harness_misfit',
              evidence: [
                {
                  type: 'snapshot',
                  anchor: 'snapshot:global-friction-total',
                  excerpt: 'global friction total exceeded threshold',
                },
              ],
            },
            proposedAction: [{ action: 'harness-tune', target: 'C2', rationale: 'missing component evidence' }],
            status: 'open',
          },
        ],
      },
    });

    assert.throws(
      () => resolveA2aEvidenceBundle({ bundleDir, verdictId }),
      /attribution finding must include at least one bundled component evidence anchor/,
    );
  });

  it('rejects provenance without raw input hashes or sanitize rules version', () => {
    const bundleDir = createBundle({ provenance: { rawInputs: [{ path: 'raw.yaml', sha256: '' }] } });

    assert.throws(() => resolveA2aEvidenceBundle({ bundleDir, verdictId }), /provenance raw input hash is required/);
  });

  it('rejects malformed provenance raw input hashes', () => {
    const bundleDir = createBundle({ provenance: { rawInputs: [{ path: 'raw.yaml', sha256: 'abc' }] } });

    assert.throws(
      () => resolveA2aEvidenceBundle({ bundleDir, verdictId }),
      /provenance raw input hash must be a 64-char lowercase sha256 digest/,
    );
  });

  it('rejects attribution refs that do not resolve to a bundled finding', () => {
    const bundleDir = createBundle();

    assert.throws(
      () =>
        resolveA2aEvidenceBundle({
          bundleDir,
          verdictId,
          attributionRefs: [`attribution:bundle/${verdictId}/AR-2026-05-22-missing`],
        }),
      /attribution ref does not resolve to a bundled finding/,
    );
  });

  it('rejects no-finding attribution refs without a bundled no-finding record', () => {
    const bundleDir = createBundle({ attribution: { findings: [] } });

    assert.throws(() => resolveA2aEvidenceBundle({ bundleDir, verdictId }), /no-finding record is required/);
  });

  it('resolves bundle with F200 featureId for memory domain', () => {
    const memVerdictId = '2026-05-24-eval-memory-live-verdict';
    const bundleDir = createBundle({
      snapshot: {
        verdictId: memVerdictId,
        evalSnapshotId: 'eval-F200-2026-05-24',
        featureId: 'F200',
      },
      attribution: {
        verdictId: memVerdictId,
        featureId: 'F200',
        evalSnapshotId: 'eval-F200-2026-05-24',
        findings: [
          {
            id: 'MEM-2026-05-24-001',
            relatedFeature: 'F200',
            frictionSignal: {
              type: 'orphan_edge_spike',
              severity: 'medium',
              confidence: 0.8,
              detectedAt: '2026-05-24T12:00:00.000Z',
            },
            attribution: {
              primaryLayer: 'graph_integrity',
              evidence: [
                {
                  type: 'counter',
                  anchor: 'C2/c2.verdict_without_pass_count',
                  excerpt: 'reusing C2 for memory domain test',
                },
              ],
            },
            proposedAction: [{ action: 'repair-orphans', target: 'F188', rationale: 'orphan count exceeds threshold' }],
            status: 'open',
          },
        ],
      },
      provenance: { verdictId: memVerdictId },
    });

    const resolved = resolveA2aEvidenceBundle({ bundleDir, verdictId: memVerdictId });
    assert.equal(resolved.snapshot.featureId, 'F200');
    assert.equal(resolved.attributionReport.featureId, 'F200');
  });

  it('accepts the exact no-finding attribution ref when the bundle records no finding', () => {
    const bundleDir = createBundle({
      attribution: {
        findings: [],
        noFindingRecord: {
          reason: 'no friction signals detected',
          evidence: 'All F167 components are below thresholds',
        },
      },
    });

    const resolved = resolveA2aEvidenceBundle({
      bundleDir,
      verdictId,
      attributionRefs: [`attribution:bundle/${verdictId}/eval-F167-2026-05-22:no-finding`],
    });

    assert.deepEqual(resolved.attributionRefs, [`attribution:bundle/${verdictId}/eval-F167-2026-05-22:no-finding`]);
  });
});
