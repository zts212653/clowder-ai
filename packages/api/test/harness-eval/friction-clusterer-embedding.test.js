import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FrictionClusterer } from '../../dist/infrastructure/harness-eval/friction/friction-clusterer.js';

// F245 Phase B Task 8 — FrictionClusterer embedding 层 + fail-open 降级
// rule 层未聚的单例 → IEmbeddingService.embed → 贪心 cosine≥τ 软聚类。未就绪/抛错 → degraded=true 仅 rule。

function sig(over = {}) {
  return {
    id: `s${Math.random()}`,
    channel: 'paw-feel',
    timestamp: '2026-06-19T10:00:00.000Z',
    tool: 'rg',
    symptom: '噪音大',
    rawRef: 'm#0',
    severity: 'medium',
    ...over,
  };
}

/** stub IEmbeddingService：vectors map text→Float32Array 控制相似度。 */
function stubEmbedding({ ready = true, vectors = new Map(), throwOnEmbed = false, throwOnReprobe = false } = {}) {
  let embedCalls = 0;
  const svc = {
    load: async () => {},
    embed: async (texts) => {
      embedCalls++;
      if (throwOnEmbed) throw new Error('embed boom');
      return texts.map((t) => vectors.get(t) ?? new Float32Array([1, 0, 0]));
    },
    isReady: () => ready,
    reprobeIfNeeded: async () => {
      if (throwOnReprobe) throw new Error('reprobe boom');
    },
    getModelInfo: () => ({ modelId: 'stub', modelRev: '1', dim: 3 }),
    dispose: () => {},
    embedCalls: () => embedCalls,
  };
  return svc;
}

describe('FrictionClusterer.cluster — embedding layer (F245 Phase B Task 8)', () => {
  it('① embedding not ready → degraded=true, rule clusters only, no throw', async () => {
    const signals = [sig({ id: 'a', tool: 'rg', symptom: 'foo' }), sig({ id: 'b', tool: 'grep', symptom: 'bar' })];
    const { clusters, degraded } = await new FrictionClusterer(stubEmbedding({ ready: false })).cluster(signals);
    assert.equal(degraded, true);
    assert.equal(clusters.length, 2, '两个单例保持 rule cluster');
    assert.ok(clusters.every((c) => c.method === 'rule'));
  });

  it('no embedding service injected → degraded=true (rule-only by construction)', async () => {
    const { clusters, degraded } = await new FrictionClusterer().cluster([sig({ id: 'a' })]);
    assert.equal(degraded, true);
    assert.equal(clusters.length, 1);
  });

  it('cloud R3 P2: reprobeIfNeeded throwing → fail-open degraded=true (not reject)', async () => {
    const signals = [sig({ id: 'a', tool: 'rg', symptom: 'foo' }), sig({ id: 'b', tool: 'grep', symptom: 'bar' })];
    const { clusters, degraded } = await new FrictionClusterer(stubEmbedding({ throwOnReprobe: true })).cluster(
      signals,
    );
    assert.equal(degraded, true, 'reprobe 抛错走 fail-open，不 reject 整个 rollup');
    assert.equal(clusters.length, 2);
    assert.ok(clusters.every((c) => c.method === 'rule'));
  });

  it('② ready + high-similarity singletons → merge into 1 embedding cluster', async () => {
    const vectors = new Map([
      ['cat slow', new Float32Array([1, 0, 0])],
      ['feline lag', new Float32Array([0.99, 0.14, 0])], // cosine ≈ 0.99 ≥ 0.82
    ]);
    const signals = [
      sig({ id: 'a', tool: 'rg', symptom: 'cat slow', channel: 'paw-feel' }),
      sig({ id: 'b', tool: 'rg', symptom: 'feline lag', channel: 'cancel' }),
    ];
    const { clusters, degraded } = await new FrictionClusterer(stubEmbedding({ vectors })).cluster(signals);
    assert.equal(degraded, false);
    assert.equal(clusters.length, 1, '高相似单例合并');
    assert.equal(clusters[0].method, 'embedding');
    assert.equal(clusters[0].count, 2);
    assert.deepEqual(clusters[0].channels, ['cancel', 'paw-feel'], '合并保留跨通道');
    assert.match(clusters[0].clusterId, /^[a-f0-9]{12}$/);
  });

  it('③ ready + low-similarity singletons → NOT merged (误聚合防护)', async () => {
    const vectors = new Map([
      ['cat slow', new Float32Array([1, 0, 0])],
      ['disk full', new Float32Array([0, 1, 0])], // cosine 0 < 0.82
    ]);
    const signals = [
      sig({ id: 'a', tool: 'rg', symptom: 'cat slow' }),
      sig({ id: 'b', tool: 'grep', symptom: 'disk full' }),
    ];
    const { clusters, degraded } = await new FrictionClusterer(stubEmbedding({ vectors })).cluster(signals);
    assert.equal(degraded, false);
    assert.equal(clusters.length, 2, '低相似不聚');
    assert.ok(clusters.every((c) => c.method === 'rule'));
  });

  it('④ threshold boundary: ≥τ merges, <τ does not (custom τ=0.9)', async () => {
    // a-b cosine 0.95 (≥0.9 merge); c orthogonal-ish to both (no merge)
    const vectors = new Map([
      ['p', new Float32Array([1, 0, 0])],
      ['q', new Float32Array([0.95, Math.sqrt(1 - 0.95 * 0.95), 0])], // cosine 0.95 with p
      ['r', new Float32Array([0, 0, 1])],
    ]);
    const signals = [
      sig({ id: 'a', tool: 't1', symptom: 'p' }),
      sig({ id: 'b', tool: 't2', symptom: 'q' }),
      sig({ id: 'c', tool: 't3', symptom: 'r' }),
    ];
    const { clusters } = await new FrictionClusterer(stubEmbedding({ vectors }), 0.9).cluster(signals);
    // p+q merge → 1 embedding cluster (count 2); r alone → 1 rule singleton
    const embedding = clusters.filter((c) => c.method === 'embedding');
    assert.equal(embedding.length, 1);
    assert.equal(embedding[0].count, 2);
    assert.equal(clusters.length, 2);
  });

  it('multi-member rule clusters pass through embedding pass untouched', async () => {
    const signals = [
      sig({ id: 'a', tool: 'rg', symptom: 'dup' }),
      sig({ id: 'b', tool: 'rg', symptom: 'dup' }), // rule cluster count=2
      sig({ id: 'c', tool: 'x', symptom: 'lonely' }), // singleton
    ];
    const vectors = new Map([['lonely', new Float32Array([0, 0, 1])]]);
    const { clusters, degraded } = await new FrictionClusterer(stubEmbedding({ vectors })).cluster(signals);
    assert.equal(degraded, false);
    const dupCluster = clusters.find((c) => c.representative === 'dup');
    assert.equal(dupCluster.count, 2);
    assert.equal(dupCluster.method, 'rule', 'rule-confirmed cluster 不被 embedding 改写');
  });

  it('embed() throwing → fail-open degraded=true, rule clusters returned', async () => {
    const signals = [sig({ id: 'a', tool: 'rg', symptom: 'foo' }), sig({ id: 'b', tool: 'grep', symptom: 'bar' })];
    const { clusters, degraded } = await new FrictionClusterer(stubEmbedding({ throwOnEmbed: true })).cluster(signals);
    assert.equal(degraded, true);
    assert.equal(clusters.length, 2);
  });

  it('fewer than 2 singletons → no embed call, degraded=false', async () => {
    const stub = stubEmbedding({});
    const { degraded } = await new FrictionClusterer(stub).cluster([sig({ id: 'a' })]);
    assert.equal(degraded, false);
    assert.equal(stub.embedCalls(), 0, '单个单例无需 embed');
  });
});
