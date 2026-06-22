import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FrictionAggregator } from '../../dist/infrastructure/harness-eval/friction/friction-aggregator.js';
import { FrictionClusterer } from '../../dist/infrastructure/harness-eval/friction/friction-clusterer.js';
import { buildFrictionRollupInput } from '../../dist/infrastructure/harness-eval/friction/friction-rollup-input.js';
import {
  CORPUS_CHANNELS,
  corpusSignalsForChannel,
  DROPPED_SIGNAL_IDS,
  groupOfSignal,
} from './__fixtures__/friction-cluster-corpus.js';

// F245 Phase B Task 9 — 端到端集成 + 误聚合 corpus gate（AC-B1 + AC-B2）

function source(channelId, signals, spy) {
  return {
    channelId,
    pull: async (sinceMs, untilMs) => {
      if (spy) spy.push([channelId, sinceMs, untilMs]);
      return signals;
    },
  };
}

function stubEmbedding({ ready = true, vectors = new Map() } = {}) {
  return {
    load: async () => {},
    embed: async (texts) => texts.map((t) => vectors.get(t) ?? new Float32Array([1, 0, 0])),
    isReady: () => ready,
    reprobeIfNeeded: async () => {},
    getModelInfo: () => ({ modelId: 'stub', modelRev: '1', dim: 3 }),
    dispose: () => {},
  };
}

function corpusAggregator(spy) {
  return new FrictionAggregator(CORPUS_CHANNELS.map((ch) => source(ch, corpusSignalsForChannel(ch), spy)));
}

describe('FrictionRollupInput integration (F245 Phase B Task 9)', () => {
  it('corpus gate (rule path): correct clusters + 误聚合率=0 + dropped meta filtered', async () => {
    const rollup = await buildFrictionRollupInput(corpusAggregator(), new FrictionClusterer(), 1000, 2000);

    // window 透传
    assert.deepEqual(rollup.window, { sinceMs: 1000, untilMs: 2000 });
    // 无 embedding → degraded；无源抛错 → droppedChannels 空
    assert.equal(rollup.degraded, true);
    assert.deepEqual(rollup.droppedChannels, []);

    // ④ 元引用被 intent filter 剔除
    const signalIds = rollup.signals.map((s) => s.id);
    for (const dropped of DROPPED_SIGNAL_IDS) {
      assert.ok(!signalIds.includes(dropped), `${dropped} 应被剔除`);
    }
    assert.equal(rollup.signals.length, 7, '8 corpus - 1 元引用 = 7 genuine');

    // ①②③ cluster 结构：rg-noise(4) + disk-full(2) + hold-ball(1) = 3 clusters
    assert.equal(rollup.clusters.length, 3);
    const rg = rollup.clusters.find((c) => c.representative === '噪音大');
    assert.equal(rg.count, 4, '① 同类×4 折叠 1 cluster');
    assert.deepEqual(rg.channels, ['cancel', 'paw-feel', 'user-feedback'], '③ 跨通道 channels 多值');
    const df = rollup.clusters.find((c) => c.representative === 'disk full');
    assert.equal(df.count, 2, '② 不同问题独立 cluster');

    // 误聚合率=0：任一 cluster 成员不跨 ground-truth group
    for (const c of rollup.clusters) {
      const groups = new Set(c.members.map((m) => groupOfSignal(m.signalId)));
      assert.equal(groups.size, 1, `cluster "${c.representative}" 不得跨 group（误聚合=0）`);
    }

    // 不变量：cluster 成员并集 ⊆ signals
    const idSet = new Set(signalIds);
    for (const c of rollup.clusters) {
      for (const m of c.members) {
        assert.ok(idSet.has(m.signalId), `成员 ${m.signalId} 必在 signals 内`);
      }
    }
  });

  it('ready embedding + corpus (1 singleton) → degraded=false, no spurious merge', async () => {
    const rollup = await buildFrictionRollupInput(corpusAggregator(), new FrictionClusterer(stubEmbedding()), 0, 9e12);
    assert.equal(rollup.degraded, false);
    assert.equal(rollup.clusters.length, 3, '单个 singleton 无可合并对象，cluster 数不变');
  });

  it('ready embedding merges 2 similar singletons end-to-end → 1 embedding cluster', async () => {
    const vectors = new Map([
      ['cat slow', new Float32Array([1, 0, 0])],
      ['feline lag', new Float32Array([0.99, 0.14, 0])],
    ]);
    const base = { timestamp: '2026-06-19T10:00:00.000Z', severity: 'medium', rawRef: 'r' };
    const aggregator = new FrictionAggregator([
      source('paw-feel', [{ ...base, id: 'a', channel: 'paw-feel', tool: 'rg', symptom: 'cat slow' }]),
      source('cancel', [{ ...base, id: 'b', channel: 'cancel', tool: 'grep', symptom: 'feline lag' }]),
    ]);
    const rollup = await buildFrictionRollupInput(
      aggregator,
      new FrictionClusterer(stubEmbedding({ vectors })),
      0,
      9e12,
    );

    assert.equal(rollup.degraded, false);
    assert.equal(rollup.clusters.length, 1);
    assert.equal(rollup.clusters[0].method, 'embedding');
    assert.equal(rollup.clusters[0].count, 2);
    // 不变量仍成立
    const idSet = new Set(rollup.signals.map((s) => s.id));
    for (const m of rollup.clusters[0].members) assert.ok(idSet.has(m.signalId));
  });

  it('forwards window to every source', async () => {
    const spy = [];
    await buildFrictionRollupInput(corpusAggregator(spy), new FrictionClusterer(), 111, 222);
    assert.ok(spy.length === CORPUS_CHANNELS.length);
    assert.ok(
      spy.every(([, s, u]) => s === 111 && u === 222),
      '所有源收到同窗口',
    );
  });

  it('cloud R3 P2: source throw → rollup degraded=true + droppedChannels (even with embedding ready)', async () => {
    const base = { timestamp: '2026-06-19T10:00:00.000Z', severity: 'medium', rawRef: 'r' };
    const aggregator = new FrictionAggregator([
      source('paw-feel', [{ ...base, id: 'a', channel: 'paw-feel', tool: 'rg', symptom: 'noise' }]),
      {
        channelId: 'user-feedback',
        pull: async () => {
          throw new Error('redis scan failed');
        },
      },
    ]);
    const rollup = await buildFrictionRollupInput(aggregator, new FrictionClusterer(stubEmbedding()), 0, 9e12);
    assert.equal(rollup.degraded, true, '源抛错 → degraded（即便 embedding 就绪、聚类未降级）');
    assert.deepEqual(rollup.droppedChannels, ['user-feedback'], '缺的通道被点名，Phase C 不当作完整');
    assert.equal(rollup.signals.length, 1, 'paw-feel 仍正常采集');
  });
});
