import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chdir, cwd } from 'node:process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadEvalHubSummary } from '../../dist/infrastructure/harness-eval/eval-hub-read-model.js';

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const repoHarnessFeedbackRoot = fileURLToPath(new URL('../../../../docs/harness-feedback', import.meta.url));
const apiPackageRoot = fileURLToPath(new URL('../../', import.meta.url));

describe('Eval Hub read model', () => {
  it('loads committed live eval:a2a verdicts with bundle-backed evidence', () => {
    const summary = loadEvalHubSummary({ harnessFeedbackRoot: repoHarnessFeedbackRoot });

    assert.equal(summary.items.length, 1);
    assert.equal(summary.counts.total, 1);
    assert.equal(summary.counts.keepObserve, 1);
    assert.equal(summary.counts.actionable, 0);

    const item = summary.items[0];
    assert.equal(item.id, '2026-05-23-eval-a2a-live-verdict');
    assert.equal(item.domainId, 'eval:a2a');
    assert.equal(item.packetId, 'vhp_eval_a2a_2026_05_23T03_12_57_174Z_eval_F167_2026_05_23_no_finding');
    assert.equal(item.verdict, 'keep_observe');
    assert.equal(item.feedbackType, 'live-verdict');
    assert.equal(item.harnessUnderEval.featureId, 'F167');
    assert.equal(item.harnessUnderEval.componentId, 'C1');
    assert.equal(item.harnessUnderEval.name, 'hold_ball (MCP tool)');
    assert.match(item.phenomenon, /No actionable A2A findings/);
    assert.match(item.ownerAsk, /keep observing/);
    assert.equal(item.reeval.nextEvalAt, '2026-05-26T03:12:57.174Z');
    assert.equal(item.reeval.status, 'observing');
    assert.equal(item.lifecycle.ownerResponseStatus, 'not_required');
    assert.equal(item.lifecycle.closureStatus, 'observing');
    assert.equal(item.lifecycle.stale, false);

    assert.deepEqual(item.evidence.snapshotRefs, ['snapshot:bundle/2026-05-23-eval-a2a-live-verdict/snapshot']);
    assert.deepEqual(item.evidence.attributionRefs, [
      'attribution:bundle/2026-05-23-eval-a2a-live-verdict/eval-F167-2026-05-23:no-finding',
    ]);
    assert.ok(item.evidence.metricRefs.includes('metric:c1.zombie_hold_count'));
    assert.deepEqual(item.evidence.otherRefs, [
      'Checked components: L1, C1, C2, route-serial. Friction metrics examined: c1.zombie_hold_count, c1.hold_cancel_count, c2.verdict_without_pass_count, c2.void_hold_hint_emitted. All values within threshold.',
    ]);
    assert.equal(item.trend.window.durationHours, 21.45);
    assert.equal(item.trend.components.length, 4);
    assert.equal(item.trend.components[1].componentId, 'C1');

    assert.equal(item.systemWorkspace.kind, 'eval_domain');
    assert.equal(item.systemWorkspace.id, 'eval:a2a');
    assert.equal(item.systemWorkspace.threadId, 'thread_eval_a2a');
    assert.equal(item.source.verdictPath, 'docs/harness-feedback/verdicts/2026-05-23-eval-a2a-live-verdict.md');
    assert.equal(item.source.bundleDir, 'docs/harness-feedback/bundles/2026-05-23-eval-a2a-live-verdict');
  });

  it('returns repo-relative source paths even when the API process runs from a package directory', () => {
    const originalCwd = cwd();
    try {
      chdir(apiPackageRoot);
      const summary = loadEvalHubSummary({ harnessFeedbackRoot: repoHarnessFeedbackRoot });

      assert.equal(
        summary.items[0].source.verdictPath,
        'docs/harness-feedback/verdicts/2026-05-23-eval-a2a-live-verdict.md',
      );
      assert.equal(summary.items[0].source.bundleDir, 'docs/harness-feedback/bundles/2026-05-23-eval-a2a-live-verdict');
    } finally {
      chdir(originalCwd);
    }
  });

  it('uses domain_id from verdict frontmatter to set item domainId', () => {
    const harnessFeedbackRoot = mkdtempSync(join(tmpdir(), 'f192-eval-hub-multi-'));
    const domainsDir = join(harnessFeedbackRoot, 'eval-domains');
    const verdictsDir = join(harnessFeedbackRoot, 'verdicts');
    mkdirSync(domainsDir, { recursive: true });
    mkdirSync(verdictsDir, { recursive: true });

    // Register both domains
    const a2aYaml = readFileSync(join(repoHarnessFeedbackRoot, 'eval-domains', 'eval-a2a.yaml'), 'utf8');
    const memYaml = readFileSync(join(repoHarnessFeedbackRoot, 'eval-domains', 'eval-memory.yaml'), 'utf8');
    writeFileSync(join(domainsDir, 'eval-a2a.yaml'), a2aYaml);
    writeFileSync(join(domainsDir, 'eval-memory.yaml'), memYaml);

    // Create A2A verdict + bundle
    const a2aVerdictId = '2026-05-24-eval-a2a-test';
    const a2aBundleDir = join(harnessFeedbackRoot, 'bundles', a2aVerdictId);
    mkdirSync(a2aBundleDir, { recursive: true });
    writeFileSync(
      join(verdictsDir, `${a2aVerdictId}.md`),
      `---
feedback_type: live-verdict
domain_id: eval:a2a
packet_id: vhp_a2a_test
---

# Live Verdict — ${a2aVerdictId}

- Verdict: \`keep_observe\`
- Phenomenon: No actionable A2A findings: clean
- Harness: F167/C1 (hold_ball (MCP tool))
- Owner ask: No action required; keep observing.
- Re-eval: next eval at 2026-05-27T00:00:00.000Z

Evidence:
- snapshot:bundle/${a2aVerdictId}/snapshot
- attribution:bundle/${a2aVerdictId}/eval-F167-2026-05-24:no-finding
- metric:c1.zombie_hold_count
`,
    );
    writeJson(join(a2aBundleDir, 'snapshot.json'), {
      verdictId: a2aVerdictId,
      evalSnapshotId: 'eval-F167-2026-05-24',
      featureId: 'F167',
      generatedAt: '2026-05-24T12:00:00.000Z',
      window: { durationHours: 24 },
      components: [
        {
          id: 'C1',
          name: 'hold_ball (MCP tool)',
          activationCounts: { hold_count: 5 },
          frictionCounts: { 'c1.zombie_hold_count': 0 },
          confidence: 'medium',
        },
      ],
    });
    writeJson(join(a2aBundleDir, 'attribution.json'), {
      verdictId: a2aVerdictId,
      featureId: 'F167',
      evalSnapshotId: 'eval-F167-2026-05-24',
      generatedAt: '2026-05-24T12:01:00.000Z',
      findings: [],
      noFindingRecord: { reason: 'clean', evidence: 'all within threshold' },
    });
    writeJson(join(a2aBundleDir, 'provenance.json'), {
      verdictId: a2aVerdictId,
      generatedAt: '2026-05-24T12:02:00.000Z',
      rawInputs: [{ path: 'raw.yaml', sha256: 'a'.repeat(64) }],
      generator: { name: 'test', version: '1' },
      sanitizeRulesVersion: 'v1',
    });

    // Create memory verdict + bundle
    const memVerdictId = '2026-05-24-eval-memory-test';
    const memBundleDir = join(harnessFeedbackRoot, 'bundles', memVerdictId);
    mkdirSync(memBundleDir, { recursive: true });
    writeFileSync(
      join(verdictsDir, `${memVerdictId}.md`),
      `---
feedback_type: live-verdict
domain_id: eval:memory
packet_id: vhp_memory_test
---

# Live Verdict — ${memVerdictId}

- Verdict: \`keep_observe\`
- Phenomenon: No actionable memory findings: all metrics within threshold
- Harness: F200/memory-recall (Memory Recall & Library Health)
- Owner ask: No action required; keep observing.
- Re-eval: next eval at 2026-05-31T00:00:00.000Z

Evidence:
- snapshot:bundle/${memVerdictId}/snapshot
- attribution:bundle/${memVerdictId}/eval-F200-2026-05-24:no-finding
- metric:mrr
`,
    );
    writeJson(join(memBundleDir, 'snapshot.json'), {
      verdictId: memVerdictId,
      evalSnapshotId: 'eval-F200-2026-05-24',
      featureId: 'F200',
      generatedAt: '2026-05-24T14:00:00.000Z',
      window: { durationHours: 168 },
      components: [
        {
          id: 'memory-recall',
          name: 'Memory Recall & Library Health',
          activationCounts: { recall_events: 142 },
          frictionCounts: { abandonment_rate: 0 },
          confidence: 'medium',
        },
      ],
    });
    writeJson(join(memBundleDir, 'attribution.json'), {
      verdictId: memVerdictId,
      featureId: 'F200',
      evalSnapshotId: 'eval-F200-2026-05-24',
      generatedAt: '2026-05-24T14:01:00.000Z',
      findings: [],
      noFindingRecord: { reason: 'all metrics within threshold', evidence: 'MRR 0.72 >= 0.5' },
    });
    writeJson(join(memBundleDir, 'provenance.json'), {
      verdictId: memVerdictId,
      generatedAt: '2026-05-24T14:02:00.000Z',
      rawInputs: [{ path: 'recall-metrics.json', sha256: 'c'.repeat(64) }],
      generator: { name: 'eval-memory-adapter', version: '1' },
      sanitizeRulesVersion: 'v1',
    });

    const summary = loadEvalHubSummary({ harnessFeedbackRoot });
    assert.equal(summary.items.length, 2);

    const a2aItem = summary.items.find((i) => i.domainId === 'eval:a2a');
    const memItem = summary.items.find((i) => i.domainId === 'eval:memory');
    assert.ok(a2aItem, 'should have eval:a2a item');
    assert.ok(memItem, 'should have eval:memory item');
    assert.equal(memItem.harnessUnderEval.featureId, 'F200');
    assert.equal(memItem.systemWorkspace.id, 'eval:memory');
    assert.equal(memItem.systemWorkspace.threadId, 'thread_eval_memory');
  });

  it('fails closed when a live verdict points at a missing evidence bundle', () => {
    const harnessFeedbackRoot = mkdtempSync(join(tmpdir(), 'f192-eval-hub-'));
    const verdictPath = join(harnessFeedbackRoot, 'verdicts', '2026-05-24-bad-live-verdict.md');
    mkdirSync(dirname(verdictPath), { recursive: true });
    writeFileSync(
      verdictPath,
      `---
feature_ids: [F192, F167]
topics: [harness-eval, eval-a2a, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:a2a
packet_id: vhp_bad
source_snapshot: "snapshot:bundle/2026-05-24-bad-live-verdict/snapshot"
---

# Live Verdict - 2026-05-24-bad-live-verdict

- Verdict: \`keep_observe\`
- Phenomenon: Missing bundle should fail closed
- Harness: F167/C1 (hold_ball (MCP tool))
- Owner ask: No action required; keep observing.
- Re-eval: next eval remains clean at 2026-05-27T00:00:00.000Z

Evidence:
- snapshot:bundle/2026-05-24-bad-live-verdict/snapshot
- attribution:bundle/2026-05-24-bad-live-verdict/eval-F167-2026-05-24:no-finding
- metric:c1.zombie_hold_count
`,
      'utf8',
    );

    assert.throws(
      () => loadEvalHubSummary({ harnessFeedbackRoot }),
      /failed to resolve evidence bundle for 2026-05-24-bad-live-verdict/,
    );
  });
});
