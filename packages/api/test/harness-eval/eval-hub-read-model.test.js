import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chdir, cwd } from 'node:process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadEvalHubSummary } from '../../dist/infrastructure/harness-eval/hub/eval-hub-read-model.js';

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const repoHarnessFeedbackRoot = fileURLToPath(new URL('../../../../docs/harness-feedback', import.meta.url));
const apiPackageRoot = fileURLToPath(new URL('../../', import.meta.url));

// Pin staleness reference time so the committed fixture verdict
// (nextEvalAt = 2026-05-26T03:12:57.174Z) stays "fresh" regardless of wall clock.
const FIXTURE_NOW_BEFORE_DEADLINE = new Date('2026-05-23T12:00:00.000Z');
// PR-3 R1: FIXTURE_NOW_AFTER_DEADLINE moved to eval-hub-read-model-lifecycle.test.js
// (only used by stale-lifecycle tests now in that file).

// PR-3 R1: writeA2aLiveVerdict / setupA2aOnlyHarnessFeedbackRoot helpers moved to
// `eval-hub-read-model-lifecycle.test.js` (where they're consumed by supersede tests).

describe('Eval Hub read model', () => {
  it('loads committed live eval:a2a verdicts with bundle-backed evidence', () => {
    const summary = loadEvalHubSummary({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      now: FIXTURE_NOW_BEFORE_DEADLINE,
    });

    // PR-3 (F192 H 收尾): #2114 merge added 2nd verdict to repo. Find fixture by
    // id, tolerate accumulation (future scheduled evals add more verdicts).
    assert.ok(summary.items.length >= 1);
    assert.ok(summary.counts.total >= 1);
    assert.ok(summary.counts.keepObserve >= 1);
    // PR-3 R3 (cloud R5 P2): don't assert repo-wide counts as exact values — future
    // scheduled evals can add fix/build/delete_sunset verdicts → counts.actionable
    // legitimately grows. Per-fixture assertions below check fixture state directly.
    assert.ok(summary.counts.actionable >= 0);
    assert.ok(summary.counts.stale >= 0);

    const item = summary.items.find((v) => v.id === '2026-05-23-eval-a2a-live-verdict');
    assert.ok(item, 'fixture verdict 2026-05-23-eval-a2a-live-verdict must remain in summary');
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

      // PR-3 (F192 H 收尾): #2114 merge added 2nd verdict. Find by id, not index
      // (test purpose: verify repo-relative paths, not verdict count).
      const item = summary.items.find((v) => v.id === '2026-05-23-eval-a2a-live-verdict');
      assert.ok(item, 'fixture verdict must remain in summary');
      assert.equal(item.source.verdictPath, 'docs/harness-feedback/verdicts/2026-05-23-eval-a2a-live-verdict.md');
      assert.equal(item.source.bundleDir, 'docs/harness-feedback/bundles/2026-05-23-eval-a2a-live-verdict');
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

    // Register both domains + create A2A verdict + bundle
    writeFileSync(
      join(domainsDir, 'eval-a2a.yaml'),
      readFileSync(join(repoHarnessFeedbackRoot, 'eval-domains', 'eval-a2a.yaml'), 'utf8'),
    );
    writeFileSync(
      join(domainsDir, 'eval-memory.yaml'),
      readFileSync(join(repoHarnessFeedbackRoot, 'eval-domains', 'eval-memory.yaml'), 'utf8'),
    );
    writeFileSync(
      join(domainsDir, 'eval-memory.metrics.yaml'),
      readFileSync(join(repoHarnessFeedbackRoot, 'eval-domains', 'eval-memory.metrics.yaml'), 'utf8'),
    );
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
    // attribution + provenance: compact to fit AGENTS.md 350-line limit (PR-3 R2)
    // biome-ignore format: keep one-liner to fit 350-line limit
    writeJson(join(a2aBundleDir, 'attribution.json'), { verdictId: a2aVerdictId, featureId: 'F167', evalSnapshotId: 'eval-F167-2026-05-24', generatedAt: '2026-05-24T12:01:00.000Z', findings: [], noFindingRecord: { reason: 'clean', evidence: 'all within threshold' } });
    // biome-ignore format: keep one-liner to fit 350-line limit (PR-3 R2)
    writeJson(join(a2aBundleDir, 'provenance.json'), { verdictId: a2aVerdictId, generatedAt: '2026-05-24T12:02:00.000Z', rawInputs: [{ path: 'raw.yaml', sha256: 'a'.repeat(64) }], generator: { name: 'test', version: '1' }, sanitizeRulesVersion: 'v1' });
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
    // biome-ignore format: keep one-liner to fit 350-line limit (PR-3 R2)
    writeJson(join(memBundleDir, 'attribution.json'), { verdictId: memVerdictId, featureId: 'F200', evalSnapshotId: 'eval-F200-2026-05-24', generatedAt: '2026-05-24T14:01:00.000Z', findings: [], noFindingRecord: { reason: 'all metrics within threshold', evidence: 'MRR 0.72 >= 0.5' } });
    // biome-ignore format: keep one-liner to fit 350-line limit (PR-3 R2)
    writeJson(join(memBundleDir, 'provenance.json'), { verdictId: memVerdictId, generatedAt: '2026-05-24T14:02:00.000Z', rawInputs: [{ path: 'recall-metrics.json', sha256: 'c'.repeat(64) }], generator: { name: 'eval-memory-adapter', version: '1' }, sanitizeRulesVersion: 'v1' });

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
    // F248 (co-creator 2026-06-29): 别硬编码域数——域列表会增减，从 eval-domains/ 目录
    // 动态数。加域时此断言不破，仍验证 "Hub 显示所有注册域" 的核心不变量。
    const expectedDomainCount = readdirSync(join(repoHarnessFeedbackRoot, 'eval-domains')).filter(
      (f) => f.endsWith('.yaml') && !f.endsWith('.metrics.yaml'),
    ).length;
    assert.ok(expectedDomainCount >= 7, `sanity: expected >= 7 eval domains, found ${expectedDomainCount}`);
    assert.equal(
      summary.domains.length,
      expectedDomainCount,
      'Hub must surface every registered eval domain (count derived from eval-domains/ dir, not hardcoded)',
    );
    assert.equal(summary.counts.registeredDomains, expectedDomainCount);
    // F245 Phase C: eval:friction registered + enabled:true since PR1b wired the live sink.
    const frictionDomain = summary.domains.find((d) => d.domainId === 'eval:friction');
    assert.ok(frictionDomain, 'eval:friction must appear in Hub domains');
    assert.equal(frictionDomain.enabled, true, 'eval:friction enabled:true after PR1b live sink wiring');

    const a2aDomain = summary.domains.find((d) => d.domainId === 'eval:a2a');
    assert.ok(a2aDomain, 'eval:a2a must appear in domains');
    assert.equal(a2aDomain.hasVerdict, true);
    assert.ok(a2aDomain.latestVerdictId, 'eval:a2a should have latestVerdictId');
    assert.equal(a2aDomain.evalCatHandle, '@codex');

    const memoryDomain = summary.domains.find((d) => d.domainId === 'eval:memory');
    assert.ok(memoryDomain, 'eval:memory must appear in domains');
    // Updated 2026-06-10: PR #2187 merged the first eval:memory live verdict.
    assert.equal(memoryDomain.hasVerdict, true);
    assert.ok(memoryDomain.latestVerdictId, 'eval:memory should have latestVerdictId');
    assert.equal(memoryDomain.evalCatHandle, '@opus47');

    const sopDomain = summary.domains.find((d) => d.domainId === 'eval:sop');
    assert.ok(sopDomain, 'eval:sop must appear in domains (weekly domain)');
    // Updated 2026-07-14: PR #2890 merged the first eval:sop verdict.
    assert.equal(sopDomain.hasVerdict, true);
    assert.ok(sopDomain.latestVerdictId, 'eval:sop should have latestVerdictId');
    assert.equal(sopDomain.evalCatHandle, '@opus47');

    const capabilityWakeupDomain = summary.domains.find((d) => d.domainId === 'eval:capability-wakeup');
    assert.ok(capabilityWakeupDomain, 'eval:capability-wakeup must appear in domains');
    // Updated 2026-06-06: PR #2129 merged cap-wakeup-c1-baseline-probe verdict to main
    assert.equal(capabilityWakeupDomain.hasVerdict, true);
    assert.ok(capabilityWakeupDomain.latestVerdictId, 'eval:capability-wakeup should have latestVerdictId');
    assert.equal(capabilityWakeupDomain.evalCatHandle, '@opus47');

    // F253 Phase C: eval:qc domain (zero-baseline, weekly, opus).
    // Updated 2026-07-12: PR #2889 published the first eval:qc live verdict.
    const qcDomain = summary.domains.find((d) => d.domainId === 'eval:qc');
    assert.ok(qcDomain, 'eval:qc must appear in domains (F253 Phase C)');
    assert.equal(qcDomain.hasVerdict, true);
    assert.ok(qcDomain.latestVerdictId, 'eval:qc should have latestVerdictId');
    assert.equal(qcDomain.evalCatHandle, '@opus');
  });

  // F248 Phase A: the registry's human description must reach the Eval Hub summary.
  it('projects descriptionForHuman from the registry into domain summaries (F248-A)', () => {
    const summary = loadEvalHubSummary({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      now: FIXTURE_NOW_BEFORE_DEADLINE,
    });

    const a2aDomain = summary.domains.find((d) => d.domainId === 'eval:a2a');
    assert.ok(a2aDomain, 'eval:a2a must appear in domains');
    assert.ok(
      a2aDomain.descriptionForHuman?.includes('协作'),
      'a2a descriptionForHuman must be projected verbatim from eval-a2a.yaml (contains 协作)',
    );

    // Every production domain summary carries a non-empty human description —
    // the read-model side of the F248 production-completeness invariant.
    for (const d of summary.domains) {
      assert.ok(
        typeof d.descriptionForHuman === 'string' && d.descriptionForHuman.length > 0,
        `${d.domainId} summary must carry a non-empty descriptionForHuman`,
      );
    }
  });

  it('projects metricGlossary and synthesized verdict summaries for Eval Hub readability (F248-B)', () => {
    const summary = loadEvalHubSummary({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      now: FIXTURE_NOW_BEFORE_DEADLINE,
    });

    const a2aDomain = summary.domains.find((d) => d.domainId === 'eval:a2a');
    assert.ok(a2aDomain, 'eval:a2a must appear in domains');
    assert.equal(a2aDomain.metricGlossary?.['c1.hold_zombie_count']?.label, '真正卡住的持球');
    assert.equal(a2aDomain.metricGlossary?.['c1.zombie_hold_count']?.goodDirection, 'lower');
    assert.equal(
      a2aDomain.metricGlossary?.['c2.verdict_without_pass_count']?.means.includes('结论'),
      true,
      'A2A metric glossary should explain c2.verdict_without_pass_count',
    );

    const a2aItem = summary.items.find((item) => item.id === '2026-05-23-eval-a2a-live-verdict');
    assert.ok(a2aItem, 'fixture verdict 2026-05-23-eval-a2a-live-verdict must remain in summary');
    assert.equal(a2aItem.operatorNarrative.evidenceQuality, 'usable');
    assert.match(a2aItem.operatorNarrative.headline, /没有发现要处理的问题/);
    assert.match(a2aItem.operatorNarrative.summary, /本轮数据可用/);
    assert.match(a2aItem.operatorNarrative.action, /不用处理/);
    assert.doesNotMatch(a2aItem.operatorNarrative.summary, /No actionable|keep observing/);
  });

  // PR-3 R1 (砚砚 P1): lifecycle.stale tests + writeA2aLiveVerdict / setupA2aOnlyHarnessFeedbackRoot
  // helpers extracted to `eval-hub-read-model-lifecycle.test.js` (AGENTS.md 350-line limit).
});
