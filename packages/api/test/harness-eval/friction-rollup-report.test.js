import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildFrictionRollupReport } from '../../dist/infrastructure/harness-eval/friction/friction-rollup-report.js';

// F245 Phase C P1-3 — FrictionRollupReport producer: Top-N 配额 + 长尾折叠 + token 上限。
// 排序 = severity × count × channelDiversity（severity 由 cluster 成员 join input.signals 取，取最高）。
// 纯函数：buildFrictionRollupReport(input, generatedAt, opts?) → FrictionRollupReport。

function sig(id, severity, channel = 'paw-feel') {
  return { id, channel, timestamp: '2026-06-20T00:00:00.000Z', symptom: id, rawRef: id, severity };
}

/**
 * cluster + its member signals. Honors Phase B invariant count === members.length:
 * generates `count` members (round-robin across channels) each with a matching signal.
 */
function clusterWithSigs(id, { count = 1, channels = ['paw-feel'], severity = 'medium', rep } = {}) {
  const members = Array.from({ length: count }, (_, i) => ({
    signalId: `${id}:m${i}`,
    rawRef: `${id}:m${i}`,
    channel: channels[i % channels.length],
  }));
  const signals = members.map((m) => sig(m.signalId, severity, m.channel));
  return {
    cluster: { clusterId: id, representative: rep ?? id, channels, count, members, method: 'rule' },
    signals,
  };
}

function inputOf(pairs, over = {}) {
  return {
    window: { sinceMs: 1000, untilMs: 2000 },
    signals: pairs.flatMap((p) => p.signals),
    clusters: pairs.map((p) => p.cluster),
    degraded: false,
    droppedChannels: [],
    ...over,
  };
}

describe('buildFrictionRollupReport (F245 Phase C P1-3)', () => {
  it('Top-10 deep + long-tail fold: 12 clusters → 10 top + 2 folded', () => {
    const pairs = Array.from({ length: 12 }, (_, i) => clusterWithSigs(`c${i}`, { count: 12 - i }));
    const report = buildFrictionRollupReport(inputOf(pairs), '2026-06-20T00:00:00.000Z');

    assert.equal(report.topClusters.length, 10, 'Top-10 深挖');
    assert.equal(report.tailSummary.clusterCount, 2, '2 个折叠进长尾');
    assert.equal(report.topClusters[0].count, 12, '最高分排第一');
    // tail = two lowest-count clusters (count 2 and 1) → 3 member signals, all paw-feel
    assert.equal(report.tailSummary.signalCount, 3, '长尾成员信号总数');
    assert.deepEqual(report.tailSummary.byChannel, { 'paw-feel': 3 }, '长尾按通道计数');
  });

  it('ranks by severity × count × channelDiversity (not count alone)', () => {
    // A: count 3, 1 channel, medium → 2×3×1 = 6
    // B: count 2, 2 channels, high → 3×2×2 = 12 (wins despite lower count)
    // C: count 2, 1 channel, low → 1×2×1 = 2
    const a = clusterWithSigs('A', { count: 3, channels: ['paw-feel'], severity: 'medium' });
    const b = clusterWithSigs('B', { count: 2, channels: ['paw-feel', 'cancel'], severity: 'high' });
    const c = clusterWithSigs('C', { count: 2, channels: ['paw-feel'], severity: 'low' });
    const report = buildFrictionRollupReport(inputOf([a, c, b]), '2026-06-20T00:00:00.000Z');

    assert.deepEqual(
      report.topClusters.map((cl) => cl.clusterId),
      ['B', 'A', 'C'],
      'B(12) > A(6) > C(2) — diversity+severity 压过纯 count',
    );
  });

  it('< topN clusters → all in top, empty tail', () => {
    const pairs = [clusterWithSigs('x', { count: 2 }), clusterWithSigs('y', { count: 1 })];
    const report = buildFrictionRollupReport(inputOf(pairs), '2026-06-20T00:00:00.000Z');
    assert.equal(report.topClusters.length, 2);
    assert.equal(report.tailSummary.clusterCount, 0);
    assert.equal(report.tailSummary.signalCount, 0);
    assert.deepEqual(report.tailSummary.byChannel, {});
  });

  it('passes through window / degraded / droppedChannels and sets generatedAt', () => {
    const report = buildFrictionRollupReport(
      inputOf([clusterWithSigs('x')], { degraded: true, droppedChannels: ['user-feedback'] }),
      '2026-06-20T12:34:56.000Z',
    );
    assert.deepEqual(report.window, { sinceMs: 1000, untilMs: 2000 });
    assert.equal(report.degraded, true);
    assert.deepEqual(report.droppedChannels, ['user-feedback']);
    assert.equal(report.generatedAt, '2026-06-20T12:34:56.000Z');
  });

  it('token budget: cap default 4000, estimated computed within cap for small report', () => {
    const report = buildFrictionRollupReport(inputOf([clusterWithSigs('x')]), '2026-06-20T00:00:00.000Z');
    assert.equal(report.tokenBudget.cap, 4000);
    assert.ok(report.tokenBudget.estimated > 0, 'estimated 非零');
    assert.ok(report.tokenBudget.estimated <= report.tokenBudget.cap, '小报告在预算内');
  });

  it('hard token cap: oversized report folds top→tail until within cap', () => {
    // 10 clusters with long representatives inflate JSON; a tiny cap forces fold-down
    const pairs = Array.from({ length: 10 }, (_, i) =>
      clusterWithSigs(`c${i}`, { count: 10 - i, rep: 'x'.repeat(200) }),
    );
    const report = buildFrictionRollupReport(inputOf(pairs), '2026-06-20T00:00:00.000Z', { tokenCap: 300 });
    assert.ok(report.tokenBudget.estimated <= 300, `estimated ${report.tokenBudget.estimated} within hard cap 300`);
    assert.ok(report.topClusters.length < 10, 'folded deep clusters into tail to fit cap');
    // cloud R3 P2: the ACTUAL serialized report (with the real `estimated` value written)
    // must also be within cap — not just the internal estimate measured with a placeholder.
    const actualTokens = Math.ceil(JSON.stringify(report).length / 4);
    assert.ok(actualTokens <= 300, `actual serialized ${actualTokens} tokens must be <= hard cap 300`);
  });

  it('custom topN + cap via opts', () => {
    const pairs = Array.from({ length: 5 }, (_, i) => clusterWithSigs(`c${i}`, { count: 5 - i }));
    const report = buildFrictionRollupReport(inputOf(pairs), '2026-06-20T00:00:00.000Z', { topN: 3, tokenCap: 2000 });
    assert.equal(report.topClusters.length, 3);
    assert.equal(report.tailSummary.clusterCount, 2);
    assert.equal(report.tokenBudget.cap, 2000);
  });

  it('cluster severity = max over members (join input.signals)', () => {
    // multi cluster: members low + high → cluster severity high → ranks above a medium cluster
    const multi = {
      cluster: {
        clusterId: 'multi',
        representative: 'multi',
        channels: ['paw-feel'],
        count: 2,
        members: [
          { signalId: 'm-lo', rawRef: 'm-lo', channel: 'paw-feel' },
          { signalId: 'm-hi', rawRef: 'm-hi', channel: 'paw-feel' },
        ],
        method: 'rule',
      },
      signals: [sig('m-lo', 'low'), sig('m-hi', 'high')],
    };
    const solo = clusterWithSigs('solo', { count: 2, severity: 'medium' });
    const report = buildFrictionRollupReport(inputOf([solo, multi]), '2026-06-20T00:00:00.000Z');
    // multi: max(low,high)=high → 3×2×1=6 ; solo: 2×2×1=4 → multi first
    assert.equal(report.topClusters[0].clusterId, 'multi');
    // cloud R2 P2: max severity surfaced on the cluster (not just used for ranking + discarded)
    assert.equal(report.topClusters[0].severity, 'high', 'multi surfaces max(low,high)=high');
    assert.equal(
      report.topClusters.find((c) => c.clusterId === 'solo').severity,
      'medium',
      'solo surfaces its severity',
    );
  });

  it('P1-4: assigns sensorForms from member channels (deterministic data-label, distinct sorted)', () => {
    const cancel = clusterWithSigs('cancel-c', { count: 2, channels: ['cancel'] });
    const paw = clusterWithSigs('paw-c', { count: 2, channels: ['paw-feel'] });
    const evald = clusterWithSigs('eval-c', { count: 2, channels: ['eval-domain'] });
    const fb = clusterWithSigs('fb-c', { count: 2, channels: ['user-feedback'] });
    const cross = clusterWithSigs('cross-c', { count: 2, channels: ['paw-feel', 'cancel'] });
    const report = buildFrictionRollupReport(inputOf([cancel, paw, evald, fb, cross]), '2026-06-20T00:00:00.000Z');
    const byId = Object.fromEntries(report.topClusters.map((c) => [c.clusterId, c.sensorForms]));
    assert.deepEqual(byId['cancel-c'], ['act']);
    assert.deepEqual(byId['paw-c'], ['reason']);
    assert.deepEqual(byId['eval-c'], ['aggregate_proxy']);
    assert.deepEqual(byId['fb-c'], ['reason']);
    assert.deepEqual(byId['cross-c'], ['act', 'reason'], '跨通道 cluster 多 sensorForm，去重升序');
  });

  it('Phase D: eval-domain-only clusters are reference-only, never actionable', () => {
    const evalOnly = clusterWithSigs('eval-only', {
      count: 3,
      channels: ['eval-domain'],
      severity: 'high',
    });
    const report = buildFrictionRollupReport(inputOf([evalOnly]), '2026-06-22T00:00:00.000Z');

    assert.equal(report.actionableCandidates.length, 0);
    assert.equal(report.referenceOnly.length, 1);
    assert.equal(report.referenceOnly[0].clusterId, 'eval-only');
    assert.equal(report.referenceOnly[0].actionability, 'reference_only');
  });

  it('Phase D: non-eval-domain clusters become actionable candidates with followup draft', () => {
    const fb = clusterWithSigs('feedback-c', {
      count: 2,
      channels: ['user-feedback'],
      severity: 'high',
    });
    const report = buildFrictionRollupReport(inputOf([fb]), '2026-06-22T00:00:00.000Z');

    assert.equal(report.referenceOnly.length, 0);
    assert.equal(report.actionableCandidates.length, 1);
    assert.equal(report.actionableCandidates[0].clusterId, 'feedback-c');
    assert.equal(report.actionableCandidates[0].actionability, 'actionable_candidate');
    assert.equal(report.actionableCandidates[0].followupDraft.clusterId, 'feedback-c');
    assert.ok(report.actionableCandidates[0].followupDraft.evidenceRefs.length > 0);
  });

  it('Phase D: mixed-channel cluster stays actionable but preserves eval-domain refs separately', () => {
    const mixed = clusterWithSigs('mixed-c', {
      count: 4,
      channels: ['eval-domain', 'user-feedback'],
      severity: 'high',
    });
    const report = buildFrictionRollupReport(inputOf([mixed]), '2026-06-22T00:00:00.000Z');

    assert.equal(report.referenceOnly.length, 0);
    assert.equal(report.actionableCandidates.length, 1);
    assert.equal(report.actionableCandidates[0].clusterId, 'mixed-c');
    assert.deepEqual(
      report.actionableCandidates[0].referenceOnlyEvidenceRefs,
      ['mixed-c:m0', 'mixed-c:m2'],
      'eval-domain member refs are preserved as reference-only evidence',
    );
  });

  it('Phase D: actionable candidate count is capped by maxProposals (default 3, configurable)', () => {
    const a = clusterWithSigs('a', { channels: ['user-feedback'], severity: 'high', count: 3 });
    const b = clusterWithSigs('b', { channels: ['cancel'], severity: 'high', count: 2 });
    const c = clusterWithSigs('c', { channels: ['paw-feel'], severity: 'medium', count: 2 });
    const d = clusterWithSigs('d', { channels: ['user-feedback'], severity: 'medium', count: 1 });

    const reportDefault = buildFrictionRollupReport(inputOf([a, b, c, d]), '2026-06-22T00:00:00.000Z');
    assert.equal(reportDefault.actionableCandidates.length, 3, 'default maxProposals=3');

    const reportCustom = buildFrictionRollupReport(inputOf([a, b, c, d]), '2026-06-22T00:00:00.000Z', {
      maxProposals: 2,
    });
    assert.equal(reportCustom.actionableCandidates.length, 2, 'custom maxProposals respected');
  });
});
