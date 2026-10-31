import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadEvalHubSummary } from '../../dist/infrastructure/harness-eval/hub/eval-hub-read-model.js';

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const FRICTION_YAML = `domainId: eval:friction
displayName: Friction Signal Eval
systemThreadId: thread_eval_friction
evalCat:
  catId: gpt52
  handle: '@gpt52'
  model: gpt-5.4
frequency: every-3d
sourceAdapter: f245-friction-rollup
sourceRefsKind: friction-rollup-snapshot
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent:
    - longitudinal-analysis
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: F245
  ownerCatId: opus-47
  threadLookup: feature-thread
sla:
  acknowledgeHours: 48
  reevalWithinHours: 168
fixtures: []
enabled: true
`;

function setupFrictionHarnessFeedbackRoot() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'f245-eval-hub-friction-'));
  const harnessFeedbackRoot = join(repoRoot, 'docs', 'harness-feedback');
  mkdirSync(join(harnessFeedbackRoot, 'eval-domains'), { recursive: true });
  mkdirSync(join(harnessFeedbackRoot, 'verdicts'), { recursive: true });
  mkdirSync(join(harnessFeedbackRoot, 'bundles'), { recursive: true });
  writeFileSync(join(harnessFeedbackRoot, 'eval-domains', 'eval-friction.yaml'), FRICTION_YAML);
  return harnessFeedbackRoot;
}

function writeFrictionVerdict(root, { verdictId = '2026-06-22-eval-friction-test', includeRawReport = true } = {}) {
  const bundleDir = join(root, 'bundles', verdictId);
  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(join(bundleDir, 'raw'), { recursive: true });
  writeFileSync(
    join(root, 'verdicts', `${verdictId}.md`),
    `---
feedback_type: live-verdict
domain_id: eval:friction
packet_id: vhp_eval_friction_test
---

# Live Verdict — ${verdictId}

- Verdict: \`keep_observe\`
- Phenomenon: Friction rollup surfaced repeated workspace confusion
- Harness: F245/friction-rollup (friction rollup)
- Owner ask: keep observing the next eval after reviewing the draft suggestions
- Re-eval: next eval at 2026-06-29T00:00:00.000Z

Evidence:
- snapshot:bundle/${verdictId}/snapshot
- attribution:bundle/${verdictId}/eval-F245-2026-06-22:no-finding
- metric:friction.cluster_count
`,
  );
  writeJson(join(bundleDir, 'snapshot.json'), {
    verdictId,
    evalSnapshotId: 'eval-F245-2026-06-22',
    featureId: 'F245',
    generatedAt: '2026-06-22T12:00:00.000Z',
    window: { startMs: 1_718_990_000_000, endMs: 1_719_250_000_000, durationHours: 72 },
    components: [
      {
        id: 'friction-rollup',
        name: 'friction rollup (Top-N + sensorForm)',
        confidence: 'medium',
        activationCounts: {},
        frictionCounts: { cluster_count: 2, top_cluster_count: 2 },
      },
    ],
  });
  writeJson(join(bundleDir, 'attribution.json'), {
    verdictId,
    featureId: 'F245',
    evalSnapshotId: 'eval-F245-2026-06-22',
    generatedAt: '2026-06-22T12:00:00.000Z',
    findings: [],
    noFindingRecord: { reason: 'fixture', evidence: 'fixture' },
  });
  writeJson(join(bundleDir, 'provenance.json'), {
    verdictId,
    generatedAt: '2026-06-22T12:00:00.000Z',
    rawInputs: [{ path: `docs/harness-feedback/bundles/${verdictId}/raw/rollup-report.json`, sha256: 'a'.repeat(64) }],
    generator: { name: 'eval-friction-live-verdict', version: '1' },
    sanitizeRulesVersion: 'f245-friction-rollup-v1',
  });

  if (includeRawReport) {
    writeJson(join(bundleDir, 'raw', 'rollup-report.json'), {
      verdictId,
      report: {
        window: { sinceMs: 1_718_990_000_000, untilMs: 1_719_250_000_000 },
        generatedAt: '2026-06-22T12:00:00.000Z',
        topClusters: [],
        actionableCandidates: [
          {
            clusterId: 'feedback-c',
            representative: 'workspace navigator path keeps being hidden',
            channels: ['user-feedback', 'paw-feel'],
            count: 3,
            members: [
              { signalId: 'feedback:1', rawRef: 'issue-1', channel: 'user-feedback' },
              { signalId: 'paw:1', rawRef: 'msg-1#0', channel: 'paw-feel' },
            ],
            method: 'rule',
            sensorForms: ['reason'],
            severity: 'high',
            actionability: 'actionable_candidate',
            followupDraft: {
              clusterId: 'feedback-c',
              title: 'Investigate friction cluster: workspace navigator path keeps being hidden',
              summary: 'workspace navigator path keeps being hidden',
              evidenceRefs: ['issue-1', 'msg-1#0'],
              reportingMode: 'final-only',
            },
            referenceOnlyEvidenceRefs: ['eval-verdict-7#component'],
          },
        ],
        referenceOnly: [
          {
            clusterId: 'eval-only',
            representative: 'eval-domain already tracks the same slow drift',
            channels: ['eval-domain'],
            count: 2,
            members: [{ signalId: 'eval:1', rawRef: 'eval-verdict-7#component', channel: 'eval-domain' }],
            method: 'rule',
            sensorForms: ['aggregate_proxy'],
            severity: 'low',
            actionability: 'reference_only',
            evidenceRefs: ['eval-verdict-7#component'],
          },
        ],
        tailSummary: { clusterCount: 0, signalCount: 0, byChannel: {} },
        degraded: false,
        droppedChannels: [],
        tokenBudget: { cap: 4000, estimated: 300 },
      },
    });
  }

  return verdictId;
}

describe('Eval Hub read model — F245 friction projections', () => {
  it('loads actionableCandidates and referenceOnly from the friction raw report bundle', () => {
    const harnessFeedbackRoot = setupFrictionHarnessFeedbackRoot();
    const verdictId = writeFrictionVerdict(harnessFeedbackRoot);

    const summary = loadEvalHubSummary({
      harnessFeedbackRoot,
      now: new Date('2026-06-22T15:00:00.000Z'),
    });
    const item = summary.items.find((entry) => entry.id === verdictId);

    assert.ok(item, 'friction verdict must be present in Hub summary');
    assert.ok(item.friction, 'friction verdict must expose Phase D projection data');
    assert.equal(item.friction.projectionStatus, 'available');
    assert.equal(item.friction.actionableCandidates.length, 1);
    assert.equal(item.friction.actionableCandidates[0].followupDraft.reportingMode, 'final-only');
    assert.deepEqual(item.friction.actionableCandidates[0].referenceOnlyEvidenceRefs, ['eval-verdict-7#component']);
    assert.equal(item.friction.referenceOnly.length, 1);
    assert.equal(item.friction.referenceOnly[0].clusterId, 'eval-only');
    assert.equal(
      item.friction.source.rawReportPath,
      `docs/harness-feedback/bundles/${verdictId}/raw/rollup-report.json`,
      'raw report path should stay repo-relative for workspace navigation',
    );
  });

  it('marks friction projection unavailable instead of inventing suggestions when the raw report is absent', () => {
    const harnessFeedbackRoot = setupFrictionHarnessFeedbackRoot();
    const verdictId = writeFrictionVerdict(harnessFeedbackRoot, { includeRawReport: false });

    const summary = loadEvalHubSummary({
      harnessFeedbackRoot,
      now: new Date('2026-06-22T15:00:00.000Z'),
    });
    const item = summary.items.find((entry) => entry.id === verdictId);

    assert.ok(item, 'friction verdict must still load without the optional raw report');
    assert.ok(item.friction, 'friction verdict must expose projection status');
    assert.equal(item.friction.projectionStatus, 'unavailable');
    assert.deepEqual(item.friction.actionableCandidates, []);
    assert.deepEqual(item.friction.referenceOnly, []);
  });
});
