import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { resolveA2aEvidenceBundle } from '../../dist/infrastructure/harness-eval/a2a/eval-a2a-artifact-resolver.js';

/**
 * Focused suite for the F192 a2a sampled-anchor BLOCKER (砚砚 cross-thread
 * report from `thread_eval_a2a` 2026-06-15T03:00Z).
 *
 * PR #2144/#2222/#2250 started writing per-fire sample attribution rows shaped
 * `<componentId>/<base_metric>/<sampleHash>` (e.g.
 * `C2/c2.verdict_without_pass_count/f7c5de78f39dc5fc`). The resolver's
 * `metricKeyForEvidenceAnchor` slice originally returned the raw suffix
 * (`c2.verdict_without_pass_count/f7c5...`) which never matched the snapshot's
 * plain `c2.verdict_without_pass_count` key → 500 generator_failed for every
 * sampled-finding bundle until normalization strips the suffix.
 *
 * Cloud Codex R1 P2 follow-up: enforce exactly one sample suffix segment so
 * malformed multi-segment refs (`<base>/foo/bar`) can't silently slip through.
 *
 * Extracted out of `eval-a2a-artifact-resolver.test.js` because that file was
 * already past the AGENTS.md 350-line hard limit before this regression suite
 * landed (cloud R1 P2).
 */

const verdictId = '2026-06-15-eval-a2a-live-verdict';

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createBundle(overrides = {}) {
  const bundleDir = mkdtempSync(join(tmpdir(), 'f192-a2a-sampled-anchor-'));
  const snapshot = {
    verdictId,
    evalSnapshotId: 'eval-F167-2026-06-15',
    featureId: 'F167',
    generatedAt: '2026-06-15T03:00:00.000Z',
    window: { startMs: 1782182400000, endMs: 1782268800000, durationHours: 24 },
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
    evalSnapshotId: 'eval-F167-2026-06-15',
    generatedAt: '2026-06-15T03:01:00.000Z',
    findings: [],
    ...(overrides.attribution ?? {}),
  };
  const provenance = {
    verdictId,
    rawInputs: [
      {
        path: 'docs/harness-feedback/snapshots/2026-06-15-F167-eval.yaml',
        sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      {
        path: 'docs/harness-feedback/attributions/2026-06-15-F167-attribution.yaml',
        sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    ],
    generatedAt: '2026-06-15T03:02:00.000Z',
    generator: { name: 'eval-a2a-live-verdict', version: '1' },
    sanitizeRulesVersion: 'f192-e-pilot-v1',
    ...(overrides.provenance ?? {}),
  };

  writeJson(join(bundleDir, 'snapshot.json'), snapshot);
  writeJson(join(bundleDir, 'attribution.json'), attribution);
  writeJson(join(bundleDir, 'provenance.json'), provenance);
  return bundleDir;
}

function findingWithEvidence(evidence, frictionType = 'c2.verdict_without_pass_count') {
  return {
    id: 'AR-2026-06-15-001',
    relatedFeature: 'F167',
    frictionSignal: { type: frictionType, severity: 'medium', confidence: 0.7, detectedAt: '2026-06-15T03:00:00.000Z' },
    attribution: { primaryLayer: 'harness_misfit', evidence },
    proposedAction: [{ action: 'harness-tune', target: 'C2', rationale: 'sampled-anchor coverage' }],
    status: 'open',
  };
}

describe('eval:a2a sampled metric anchor resolver coverage', () => {
  it('accepts per-fire sampled anchor alongside aggregate row (PR #2144 evidence pattern)', () => {
    const bundleDir = createBundle({
      attribution: {
        findings: [
          findingWithEvidence([
            {
              type: 'counter',
              anchor: 'C2/c2.verdict_without_pass_count/f7c5de78f39dc5fc',
              excerpt: 'per-fire sample: forced-pass verdict at thread/inv',
            },
            { type: 'counter', anchor: 'C2/c2.verdict_without_pass_count', excerpt: 'aggregate counter' },
          ]),
        ],
      },
    });

    const resolved = resolveA2aEvidenceBundle({ bundleDir, verdictId });

    assert.equal(resolved.attributionReport.findings[0].attribution.evidence.length, 2);
    assert.equal(
      resolved.attributionReport.findings[0].attribution.evidence[0].anchor,
      'C2/c2.verdict_without_pass_count/f7c5de78f39dc5fc',
    );
  });

  it('accepts only-sampled metric anchors with no aggregate row', () => {
    const bundleDir = createBundle({
      attribution: {
        findings: [
          findingWithEvidence([
            {
              type: 'counter',
              anchor: 'C2/c2.verdict_without_pass_count/abcd1234abcd1234',
              excerpt: 'per-fire sample only — no aggregate row',
            },
          ]),
        ],
      },
    });

    const resolved = resolveA2aEvidenceBundle({ bundleDir, verdictId });
    assert.equal(resolved.attributionReport.findings[0].attribution.evidence.length, 1);
  });

  it('still rejects sampled anchor whose base metric is absent from snapshot', () => {
    const bundleDir = createBundle({
      attribution: {
        findings: [
          findingWithEvidence(
            [
              {
                type: 'counter',
                anchor: 'C2/c2.missing_metric/f7c5de78f39dc5fc',
                excerpt: 'sampled but base metric not bundled',
              },
            ],
            'c2.missing_metric',
          ),
        ],
      },
    });

    assert.throws(
      () => resolveA2aEvidenceBundle({ bundleDir, verdictId }),
      /attribution evidence anchor does not match bundled snapshot metrics/,
    );
  });

  // Cloud Codex R1 P2: malformed multi-segment ref like
  // `C2/<base>/<foo>/<bar>` previously slipped through (first-slash truncate
  // accepted `<base>` as valid). The resolver is fail-closed bundle-integrity
  // gate before publish — malformed refs can't be silently forwarded.
  it('rejects malformed sampled anchor with more than one sample suffix segment (cloud R1 P2)', () => {
    const bundleDir = createBundle({
      attribution: {
        findings: [
          findingWithEvidence([
            {
              type: 'counter',
              anchor: 'C2/c2.verdict_without_pass_count/foo/bar',
              excerpt: 'malformed multi-segment ref must not be normalized to base',
            },
          ]),
        ],
      },
    });

    assert.throws(() => resolveA2aEvidenceBundle({ bundleDir, verdictId }), /malformed sample suffix/);
  });

  // Cloud Codex R2 P2: trailing-slash empty sample suffix
  // `C2/c2.verdict_without_pass_count/` slipped past `sampleSuffix.includes('/')`
  // because empty string contains no `/`. Now also reject empty suffix.
  it('rejects malformed sampled anchor with empty sample suffix / trailing slash (cloud R2 P2)', () => {
    const bundleDir = createBundle({
      attribution: {
        findings: [
          findingWithEvidence([
            {
              type: 'counter',
              anchor: 'C2/c2.verdict_without_pass_count/',
              excerpt: 'trailing-slash empty sample suffix must not normalize to base',
            },
          ]),
        ],
      },
    });

    assert.throws(() => resolveA2aEvidenceBundle({ bundleDir, verdictId }), /malformed sample suffix/);
  });
});
