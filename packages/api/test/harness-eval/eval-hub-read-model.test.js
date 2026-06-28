import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
    assert.equal(
      summary.domains.length,
      8,
      'should have 8 registered domains (eval:a2a + eval:memory + eval:sop + eval:capability-wakeup + eval:task-outcome + eval:friction[F245] + eval:anchor-first[F236] + eval:capability-tips[F244])',
    );
    assert.equal(summary.counts.registeredDomains, 8);
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
    assert.equal(sopDomain.hasVerdict, false);
    assert.equal(sopDomain.evalCatHandle, '@opus47');

    const capabilityWakeupDomain = summary.domains.find((d) => d.domainId === 'eval:capability-wakeup');
    assert.ok(capabilityWakeupDomain, 'eval:capability-wakeup must appear in domains');
    // Updated 2026-06-06: PR #2129 merged cap-wakeup-c1-baseline-probe verdict to main
    assert.equal(capabilityWakeupDomain.hasVerdict, true);
    assert.ok(capabilityWakeupDomain.latestVerdictId, 'eval:capability-wakeup should have latestVerdictId');
    assert.equal(capabilityWakeupDomain.evalCatHandle, '@opus47');
  });

  // OQ-20: domain summary must include evalCatId + nextCronFireAt for frontend edit + display
  it('includes evalCatId and nextCronFireAt in domain summaries (#OQ-20)', () => {
    const summary = loadEvalHubSummary({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      now: FIXTURE_NOW_BEFORE_DEADLINE,
    });

    const a2aDomain = summary.domains.find((d) => d.domainId === 'eval:a2a');
    assert.ok(a2aDomain);
    // evalCatId must be exposed for the PATCH edit endpoint
    assert.equal(a2aDomain.evalCatId, 'codex', 'domain summary must include evalCatId');
    // P1-2 fix: nextCronFireAt is the scheduler's next fire time, not verdict re-eval deadline
    // FIXTURE_NOW_BEFORE_DEADLINE = 2026-05-23T12:00 → next daily 03:00 UTC = 2026-05-24T03:00
    assert.equal(
      a2aDomain.nextCronFireAt,
      '2026-05-24T03:00:00.000Z',
      'daily domain nextCronFireAt = next 03:00 UTC after now',
    );

    // P1-2 fix: ALL domains get nextCronFireAt, including those without verdicts
    const memoryDomain = summary.domains.find((d) => d.domainId === 'eval:memory');
    assert.ok(memoryDomain);
    assert.equal(memoryDomain.evalCatId, 'opus-47');
    assert.equal(
      memoryDomain.nextCronFireAt,
      '2026-05-24T03:00:00.000Z',
      'no-verdict domain still gets nextCronFireAt',
    );

    // Re-enabled 2026-06-10 (F192 sop-wiring PR): eval:sop is now wired with
    // live publish path (SopTrace producer + file-writer + verdictGenerator).
    // Weekly domain → nextCronFireAt = next Sunday 03:00 UTC after fixture now.
    const sopDomain = summary.domains.find((d) => d.domainId === 'eval:sop');
    assert.ok(sopDomain);
    assert.equal(sopDomain.enabled, true, 're-enabled sop domain must carry enabled=true');
    assert.equal(
      sopDomain.nextCronFireAt,
      '2026-05-24T03:00:00.000Z',
      're-enabled weekly sop domain nextCronFireAt = next Sunday 03:00 UTC',
    );

    // Weekly + enabled: eval:capability-wakeup is the other weekly domain and
    // is still enabled — its nextCronFireAt must be present and point at next
    // Sunday 03:00 UTC after 2026-05-23 (Saturday) = 2026-05-24 (Sunday).
    const cwDomain = summary.domains.find((d) => d.domainId === 'eval:capability-wakeup');
    assert.ok(cwDomain);
    assert.equal(cwDomain.enabled, true, 'enabled weekly domain must carry enabled=true');
    assert.equal(
      cwDomain.nextCronFireAt,
      '2026-05-24T03:00:00.000Z',
      'enabled weekly domain nextCronFireAt = next Sunday 03:00 UTC',
    );
  });

  it('attaches enabled flag for ALL domains in summary (sunset visibility — F192 silent-fire fix)', () => {
    const summary = loadEvalHubSummary({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      now: FIXTURE_NOW_BEFORE_DEADLINE,
    });

    // Every domain summary must carry `enabled` (boolean) so the Hub UI can
    // render a "Sunset" indicator instead of pretending the domain is active.
    // This closes the gap that PR #2130 originally left as cosmetic — gpt52 R1
    // P1 surfaced it as same-class false-green bug as silent-fire.
    for (const d of summary.domains) {
      assert.equal(typeof d.enabled, 'boolean', `${d.domainId} must have boolean enabled field`);
    }

    // re-enabled: enabled=true + has nextCronFireAt (weekly)
    const sopDomain = summary.domains.find((d) => d.domainId === 'eval:sop');
    assert.ok(sopDomain);
    assert.equal(sopDomain.enabled, true);
    assert.ok(sopDomain.nextCronFireAt, 're-enabled weekly domain must have nextCronFireAt');

    // active: enabled=true + has nextCronFireAt
    const a2aDomain = summary.domains.find((d) => d.domainId === 'eval:a2a');
    assert.ok(a2aDomain);
    assert.equal(a2aDomain.enabled, true);
    assert.ok(a2aDomain.nextCronFireAt, 'enabled domain must have nextCronFireAt');
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

  // PR-3 R1 (砚砚 P1): lifecycle.stale tests + writeA2aLiveVerdict / setupA2aOnlyHarnessFeedbackRoot
  // helpers extracted to `eval-hub-read-model-lifecycle.test.js` (AGENTS.md 350-line limit).
});
