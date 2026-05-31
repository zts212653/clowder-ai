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

// Pin staleness reference time so the committed fixture verdict
// (nextEvalAt = 2026-05-26T03:12:57.174Z) stays "fresh" regardless of wall clock.
const FIXTURE_NOW_BEFORE_DEADLINE = new Date('2026-05-23T12:00:00.000Z');
const FIXTURE_NOW_AFTER_DEADLINE = new Date('2026-05-29T00:00:00.000Z');

// Shared helper for the per-domain supersede regression cases (PR 791 review feedback).
// Writes a self-consistent eval:a2a live verdict + bundle triple under harnessFeedbackRoot.
function writeA2aLiveVerdict(harnessFeedbackRoot, { verdictId, nextEvalAt, generatedAt }) {
  const verdictsDir = join(harnessFeedbackRoot, 'verdicts');
  const bundleDir = join(harnessFeedbackRoot, 'bundles', verdictId);
  mkdirSync(verdictsDir, { recursive: true });
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(
    join(verdictsDir, `${verdictId}.md`),
    `---
feedback_type: live-verdict
domain_id: eval:a2a
packet_id: vhp_${verdictId.replace(/-/g, '_')}
---

# Live Verdict — ${verdictId}

- Verdict: \`keep_observe\`
- Phenomenon: No actionable A2A findings: clean
- Harness: F167/C1 (hold_ball (MCP tool))
- Owner ask: No action required; keep observing.
- Re-eval: next eval at ${nextEvalAt}

Evidence:
- snapshot:bundle/${verdictId}/snapshot
- attribution:bundle/${verdictId}/eval-F167-${verdictId}:no-finding
- metric:c1.zombie_hold_count
`,
  );
  writeJson(join(bundleDir, 'snapshot.json'), {
    verdictId,
    evalSnapshotId: `eval-F167-${verdictId}`,
    featureId: 'F167',
    generatedAt,
    window: { durationHours: 24 },
    components: [
      {
        id: 'C1',
        name: 'hold_ball (MCP tool)',
        activationCounts: { hold_count: 1 },
        frictionCounts: { 'c1.zombie_hold_count': 0 },
        confidence: 'medium',
      },
    ],
  });
  writeJson(join(bundleDir, 'attribution.json'), {
    verdictId,
    featureId: 'F167',
    evalSnapshotId: `eval-F167-${verdictId}`,
    generatedAt,
    findings: [],
    noFindingRecord: { reason: 'clean', evidence: 'within threshold' },
  });
  writeJson(join(bundleDir, 'provenance.json'), {
    verdictId,
    generatedAt,
    rawInputs: [{ path: 'raw.yaml', sha256: 'a'.repeat(64) }],
    generator: { name: 'test', version: '1' },
    sanitizeRulesVersion: 'v1',
  });
}

function setupA2aOnlyHarnessFeedbackRoot(label) {
  const harnessFeedbackRoot = mkdtempSync(join(tmpdir(), `f192-eval-hub-${label}-`));
  const domainsDir = join(harnessFeedbackRoot, 'eval-domains');
  mkdirSync(domainsDir, { recursive: true });
  const a2aYaml = readFileSync(join(repoHarnessFeedbackRoot, 'eval-domains', 'eval-a2a.yaml'), 'utf8');
  writeFileSync(join(domainsDir, 'eval-a2a.yaml'), a2aYaml);
  return harnessFeedbackRoot;
}

describe('Eval Hub read model', () => {
  it('loads committed live eval:a2a verdicts with bundle-backed evidence', () => {
    const summary = loadEvalHubSummary({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      now: FIXTURE_NOW_BEFORE_DEADLINE,
    });

    assert.equal(summary.items.length, 1);
    assert.equal(summary.counts.total, 1);
    assert.equal(summary.counts.keepObserve, 1);
    assert.equal(summary.counts.actionable, 0);
    assert.equal(summary.counts.stale, 0);

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
      const summary = loadEvalHubSummary({
        harnessFeedbackRoot: repoHarnessFeedbackRoot,
        now: FIXTURE_NOW_BEFORE_DEADLINE,
      });

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

    const summary = loadEvalHubSummary({
      harnessFeedbackRoot,
      // Both synthesized verdicts target 2026-05-27 / 2026-05-31; pin reference
      // before the earlier deadline so neither flips to stale.
      now: new Date('2026-05-24T15:00:00.000Z'),
    });
    assert.equal(summary.items.length, 2);

    const a2aItem = summary.items.find((i) => i.domainId === 'eval:a2a');
    const memItem = summary.items.find((i) => i.domainId === 'eval:memory');
    assert.ok(a2aItem, 'should have eval:a2a item');
    assert.ok(memItem, 'should have eval:memory item');
    assert.equal(memItem.harnessUnderEval.featureId, 'F200');
    assert.equal(memItem.systemWorkspace.id, 'eval:memory');
    assert.equal(memItem.systemWorkspace.threadId, 'thread_eval_memory');
  });

  // F192 livefix OQ-16: Hub must show ALL registered domains, not just those with verdicts
  it('includes all registered domains in domains[] including those without verdicts', () => {
    const summary = loadEvalHubSummary({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      now: FIXTURE_NOW_BEFORE_DEADLINE,
    });

    assert.ok(summary.domains, 'domains field must exist');
    assert.equal(
      summary.domains.length,
      4,
      'should have 4 registered domains (eval:a2a + eval:memory + eval:sop + eval:capability-wakeup)',
    );
    assert.equal(summary.counts.registeredDomains, 4);

    const a2aDomain = summary.domains.find((d) => d.domainId === 'eval:a2a');
    assert.ok(a2aDomain, 'eval:a2a must appear in domains');
    assert.equal(a2aDomain.hasVerdict, true);
    assert.ok(a2aDomain.latestVerdictId, 'eval:a2a should have latestVerdictId');
    assert.equal(a2aDomain.evalCatHandle, '@codex');

    const memoryDomain = summary.domains.find((d) => d.domainId === 'eval:memory');
    assert.ok(memoryDomain, 'eval:memory must appear even with zero verdicts');
    assert.equal(memoryDomain.hasVerdict, false);
    assert.equal(memoryDomain.latestVerdictId, undefined);
    assert.equal(memoryDomain.evalCatHandle, '@opus47');

    const sopDomain = summary.domains.find((d) => d.domainId === 'eval:sop');
    assert.ok(sopDomain, 'eval:sop must appear in domains (weekly domain)');
    assert.equal(sopDomain.hasVerdict, false);
    assert.equal(sopDomain.evalCatHandle, '@opus47');

    const capabilityWakeupDomain = summary.domains.find((d) => d.domainId === 'eval:capability-wakeup');
    assert.ok(capabilityWakeupDomain, 'eval:capability-wakeup must appear in domains');
    assert.equal(capabilityWakeupDomain.hasVerdict, false);
    assert.equal(capabilityWakeupDomain.evalCatHandle, '@opus47');
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

  // F192 P2 — eval-hub stale lifecycle calculation regression guard
  it('marks lifecycle.stale = true and counts.stale = 1 when now is past nextEvalAt', () => {
    const summary = loadEvalHubSummary({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      now: FIXTURE_NOW_AFTER_DEADLINE,
    });

    assert.equal(summary.items.length, 1);
    assert.equal(summary.counts.stale, 1, 'counts.stale should reflect overdue lifecycle');
    const item = summary.items[0];
    assert.equal(item.lifecycle.stale, true, 'verdict past its nextEvalAt must be stale');
    // Other lifecycle/keep_observe semantics must remain untouched by the stale signal.
    assert.equal(item.verdict, 'keep_observe');
    assert.equal(item.lifecycle.closureStatus, 'observing');
    assert.equal(item.lifecycle.ownerResponseStatus, 'not_required');
  });

  // F192 P2 — boundary: at-deadline must not flip to stale (strict `>`, not `>=`)
  it('keeps lifecycle.stale = false when now equals nextEvalAt exactly', () => {
    const summary = loadEvalHubSummary({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      // Fixture nextEvalAt = 2026-05-26T03:12:57.174Z
      now: new Date('2026-05-26T03:12:57.174Z'),
    });

    assert.equal(summary.items[0].lifecycle.stale, false, 'at-deadline tick is not yet stale');
    assert.equal(summary.counts.stale, 0);
  });

  // F192 P2 — defensive: missing nextEvalAt cannot imply staleness
  it('returns lifecycle.stale = false when the Re-eval bullet lacks an ISO timestamp', () => {
    const harnessFeedbackRoot = mkdtempSync(join(tmpdir(), 'f192-eval-hub-no-deadline-'));
    const domainsDir = join(harnessFeedbackRoot, 'eval-domains');
    const verdictsDir = join(harnessFeedbackRoot, 'verdicts');
    mkdirSync(domainsDir, { recursive: true });
    mkdirSync(verdictsDir, { recursive: true });

    const a2aYaml = readFileSync(join(repoHarnessFeedbackRoot, 'eval-domains', 'eval-a2a.yaml'), 'utf8');
    writeFileSync(join(domainsDir, 'eval-a2a.yaml'), a2aYaml);

    const verdictId = '2026-05-24-eval-a2a-no-deadline';
    const bundleDir = join(harnessFeedbackRoot, 'bundles', verdictId);
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(
      join(verdictsDir, `${verdictId}.md`),
      `---
feedback_type: live-verdict
domain_id: eval:a2a
packet_id: vhp_no_deadline
---

# Live Verdict — ${verdictId}

- Verdict: \`keep_observe\`
- Phenomenon: No actionable A2A findings: clean
- Harness: F167/C1 (hold_ball (MCP tool))
- Owner ask: No action required; keep observing.
- Re-eval: window pending; date to be assigned upstream

Evidence:
- snapshot:bundle/${verdictId}/snapshot
- attribution:bundle/${verdictId}/eval-F167-2026-05-24:no-finding
- metric:c1.zombie_hold_count
`,
    );
    writeJson(join(bundleDir, 'snapshot.json'), {
      verdictId,
      evalSnapshotId: 'eval-F167-2026-05-24',
      featureId: 'F167',
      generatedAt: '2026-05-24T12:00:00.000Z',
      window: { durationHours: 24 },
      components: [
        {
          id: 'C1',
          name: 'hold_ball (MCP tool)',
          activationCounts: { hold_count: 1 },
          frictionCounts: { 'c1.zombie_hold_count': 0 },
          confidence: 'medium',
        },
      ],
    });
    writeJson(join(bundleDir, 'attribution.json'), {
      verdictId,
      featureId: 'F167',
      evalSnapshotId: 'eval-F167-2026-05-24',
      generatedAt: '2026-05-24T12:01:00.000Z',
      findings: [],
      noFindingRecord: { reason: 'clean', evidence: 'within threshold' },
    });
    writeJson(join(bundleDir, 'provenance.json'), {
      verdictId,
      generatedAt: '2026-05-24T12:02:00.000Z',
      rawInputs: [{ path: 'raw.yaml', sha256: 'b'.repeat(64) }],
      generator: { name: 'test', version: '1' },
      sanitizeRulesVersion: 'v1',
    });

    const summary = loadEvalHubSummary({
      harnessFeedbackRoot,
      now: new Date('2099-01-01T00:00:00.000Z'),
    });

    assert.equal(summary.items.length, 1);
    assert.equal(summary.items[0].reeval.nextEvalAt, undefined, 'fixture should expose missing deadline');
    assert.equal(
      summary.items[0].lifecycle.stale,
      false,
      'a verdict without a re-eval deadline cannot be classified stale',
    );
    assert.equal(summary.counts.stale, 0);
  });

  // F192 P2 — PR 791 review regression guard.
  // Stale is a *lifecycle state of the active finding per domain*, not a property of every
  // historical verdict. When a newer live verdict supersedes an older overdue one, the older
  // verdict must drop out of counts.stale; otherwise counts.stale stays non-zero forever
  // after the re-eval window closes, defeating the closure loop the Hub exists to surface.
  it('does not count an older overdue verdict as stale when a newer fresh verdict supersedes it (same domain)', () => {
    const harnessFeedbackRoot = setupA2aOnlyHarnessFeedbackRoot('supersede-fresh');

    writeA2aLiveVerdict(harnessFeedbackRoot, {
      verdictId: '2026-05-20-eval-a2a-older',
      nextEvalAt: '2026-05-23T00:00:00.000Z', // already past when now = 2026-05-27
      generatedAt: '2026-05-20T00:00:00.000Z',
    });
    writeA2aLiveVerdict(harnessFeedbackRoot, {
      verdictId: '2026-05-26-eval-a2a-newer',
      nextEvalAt: '2026-05-30T00:00:00.000Z', // fresh
      generatedAt: '2026-05-26T00:00:00.000Z',
    });

    const summary = loadEvalHubSummary({
      harnessFeedbackRoot,
      // Between older deadline (2026-05-23) and newer deadline (2026-05-30).
      now: new Date('2026-05-27T00:00:00.000Z'),
    });

    assert.equal(summary.items.length, 2);
    // Items are sorted by trend.generatedAt desc, so [0] is the newer/latest active verdict.
    assert.equal(summary.items[0].id, '2026-05-26-eval-a2a-newer');
    assert.equal(summary.items[1].id, '2026-05-20-eval-a2a-older');

    assert.equal(summary.counts.stale, 0, 'superseded older verdict must not keep counts.stale non-zero');
    assert.equal(summary.items[0].lifecycle.stale, false, 'newer verdict is fresh (deadline in future)');
    assert.equal(
      summary.items[1].lifecycle.stale,
      false,
      'older verdict is superseded by the newer one — closed by re-eval, not stale',
    );

    // Domain summary still surfaces the latest active verdict, regardless of supersede semantics.
    const a2aDomain = summary.domains.find((d) => d.domainId === 'eval:a2a');
    assert.equal(a2aDomain.latestVerdictId, '2026-05-26-eval-a2a-newer');
  });

  // F192 P2 — PR 791 review regression guard (companion case).
  // When the *latest* verdict itself is overdue, exactly one stale signal must surface per
  // domain — not one per historical overdue verdict. Without supersede gating, two overdue
  // verdicts would each tick counts.stale, double-counting a single unresolved finding.
  it('counts only the latest overdue verdict as stale per domain (not every historical overdue)', () => {
    const harnessFeedbackRoot = setupA2aOnlyHarnessFeedbackRoot('supersede-both-overdue');

    writeA2aLiveVerdict(harnessFeedbackRoot, {
      verdictId: '2026-05-15-eval-a2a-older-overdue',
      nextEvalAt: '2026-05-18T00:00:00.000Z',
      generatedAt: '2026-05-15T00:00:00.000Z',
    });
    writeA2aLiveVerdict(harnessFeedbackRoot, {
      verdictId: '2026-05-22-eval-a2a-newer-overdue',
      nextEvalAt: '2026-05-25T00:00:00.000Z',
      generatedAt: '2026-05-22T00:00:00.000Z',
    });

    const summary = loadEvalHubSummary({
      harnessFeedbackRoot,
      now: new Date('2026-05-29T00:00:00.000Z'), // past both deadlines
    });

    assert.equal(summary.items.length, 2);
    assert.equal(summary.counts.stale, 1, 'only the latest active verdict surfaces as stale');

    const latest = summary.items.find((i) => i.id === '2026-05-22-eval-a2a-newer-overdue');
    const older = summary.items.find((i) => i.id === '2026-05-15-eval-a2a-older-overdue');
    assert.equal(latest.lifecycle.stale, true, 'latest verdict past its own deadline is stale');
    assert.equal(
      older.lifecycle.stale,
      false,
      'older verdict is superseded by the newer one — even if both are overdue, only the latest counts',
    );
  });
});
