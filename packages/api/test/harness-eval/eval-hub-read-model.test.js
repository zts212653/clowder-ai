import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chdir, cwd } from 'node:process';
import { beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadEvalHubSummary } from '../../dist/infrastructure/harness-eval/hub/eval-hub-read-model.js';
import {
  createEvalHubCorpus,
  createEvalHubRoot,
  fixtureOtherRef,
  fixturePacketId,
  writeEvalHubVerdict,
} from './eval-hub-corpus-fixture.js';

let repoHarnessFeedbackRoot;
beforeEach((t) => {
  repoHarnessFeedbackRoot = createEvalHubCorpus(t);
});
const apiPackageRoot = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE_NOW_BEFORE_DEADLINE = new Date('2026-05-23T12:00:00.000Z');

describe('Eval Hub read model', () => {
  it('loads an independent live eval:a2a verdict with bundle-backed evidence', () => {
    const summary = loadEvalHubSummary({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      now: FIXTURE_NOW_BEFORE_DEADLINE,
    });
    assert.equal(summary.items.length, 5);
    assert.equal(summary.counts.total, 5);
    assert.equal(summary.counts.keepObserve, 5);
    assert.equal(summary.counts.actionable, 0);
    assert.equal(summary.counts.stale, 0);

    const item = summary.items.find((v) => v.id === 'fixture-a2a-observed-window');
    assert.ok(item, 'fixture verdict fixture-a2a-observed-window must remain in summary');
    assert.equal(item.id, 'fixture-a2a-observed-window');
    assert.equal(item.domainId, 'eval:a2a');
    assert.equal(item.packetId, fixturePacketId);
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

    assert.deepEqual(item.evidence.snapshotRefs, ['snapshot:bundle/fixture-a2a-observed-window/snapshot']);
    assert.deepEqual(item.evidence.attributionRefs, [
      'attribution:bundle/fixture-a2a-observed-window/eval-F167-fixture-a2a-observed-window:no-finding',
    ]);
    assert.ok(item.evidence.metricRefs.includes('metric:c1.zombie_hold_count'));
    assert.deepEqual(item.evidence.otherRefs, [fixtureOtherRef]);
    assert.equal(item.trend.window.durationHours, 12.5);
    assert.equal(item.trend.components.length, 4);
    assert.equal(item.trend.components[1].componentId, 'C1');

    assert.equal(item.systemWorkspace.kind, 'eval_domain');
    assert.equal(item.systemWorkspace.id, 'eval:a2a');
    assert.equal(item.systemWorkspace.threadId, 'thread_eval_a2a');
    assert.equal(item.source.verdictPath, 'docs/harness-feedback/verdicts/fixture-a2a-observed-window.md');
    assert.equal(item.source.bundleDir, 'docs/harness-feedback/bundles/fixture-a2a-observed-window');
  });

  it('returns repo-relative source paths even when the API process runs from a package directory', () => {
    const originalCwd = cwd();
    try {
      chdir(apiPackageRoot);
      const summary = loadEvalHubSummary({
        harnessFeedbackRoot: repoHarnessFeedbackRoot,
        now: FIXTURE_NOW_BEFORE_DEADLINE,
      });
      const item = summary.items.find((v) => v.id === 'fixture-a2a-observed-window');
      assert.ok(item, 'fixture verdict must remain in summary');
      assert.equal(item.source.verdictPath, 'docs/harness-feedback/verdicts/fixture-a2a-observed-window.md');
      assert.equal(item.source.bundleDir, 'docs/harness-feedback/bundles/fixture-a2a-observed-window');
    } finally {
      chdir(originalCwd);
    }
  });

  it('uses domain_id from verdict frontmatter to set item domainId', (t) => {
    const harnessFeedbackRoot = createEvalHubRoot(t);
    writeEvalHubVerdict(harnessFeedbackRoot, { verdictId: 'fixture-a2a-cross-domain' });
    writeEvalHubVerdict(harnessFeedbackRoot, {
      domainId: 'eval:memory',
      verdictId: 'fixture-memory-cross-domain',
      featureId: 'F200',
      componentId: 'memory-recall',
      componentName: 'Memory Recall & Library Health',
    });
    const summary = loadEvalHubSummary({ harnessFeedbackRoot, now: FIXTURE_NOW_BEFORE_DEADLINE });
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
    // Dormant domains stay visible with enabled:false.
    const frictionDomain = summary.domains.find((d) => d.domainId === 'eval:friction');
    assert.ok(frictionDomain, 'eval:friction must appear in Hub domains');
    assert.equal(frictionDomain.enabled, false, 'dormant eval:friction stays visible with enabled:false');
    assert.equal(frictionDomain.hasVerdict, false, 'a registered domain without a fixture verdict stays visible');

    const a2aDomain = summary.domains.find((d) => d.domainId === 'eval:a2a');
    assert.ok(a2aDomain, 'eval:a2a must appear in domains');
    assert.equal(a2aDomain.hasVerdict, true);
    assert.ok(a2aDomain.latestVerdictId, 'eval:a2a should have latestVerdictId');
    assert.equal(a2aDomain.evalCatHandle, '@codex');

    const memoryDomain = summary.domains.find((d) => d.domainId === 'eval:memory');
    assert.ok(memoryDomain, 'eval:memory must appear in domains');
    assert.equal(memoryDomain.hasVerdict, true);
    assert.ok(memoryDomain.latestVerdictId, 'eval:memory should have latestVerdictId');
    assert.equal(memoryDomain.evalCatHandle, '@opus47');

    const sopDomain = summary.domains.find((d) => d.domainId === 'eval:sop');
    assert.ok(sopDomain, 'eval:sop must appear in domains (weekly domain)');
    assert.equal(sopDomain.hasVerdict, true);
    assert.ok(sopDomain.latestVerdictId, 'eval:sop should have latestVerdictId');
    assert.equal(sopDomain.evalCatHandle, '@opus47');

    const capabilityWakeupDomain = summary.domains.find((d) => d.domainId === 'eval:capability-wakeup');
    assert.ok(capabilityWakeupDomain, 'eval:capability-wakeup must appear in domains');
    assert.equal(capabilityWakeupDomain.hasVerdict, true);
    assert.ok(capabilityWakeupDomain.latestVerdictId, 'eval:capability-wakeup should have latestVerdictId');
    assert.equal(capabilityWakeupDomain.evalCatHandle, '@opus47');

    // F253 Phase C: eval:qc domain (zero-baseline, weekly, opus).
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

    const a2aItem = summary.items.find((item) => item.id === 'fixture-a2a-observed-window');
    assert.ok(a2aItem, 'fixture verdict fixture-a2a-observed-window must remain in summary');
    assert.equal(a2aItem.operatorNarrative.evidenceQuality, 'usable');
    assert.match(a2aItem.operatorNarrative.headline, /没有发现要处理的问题/);
    assert.match(a2aItem.operatorNarrative.summary, /本轮数据可用/);
    assert.match(a2aItem.operatorNarrative.action, /不用处理/);
    assert.doesNotMatch(a2aItem.operatorNarrative.summary, /No actionable|keep observing/);
  });
});
