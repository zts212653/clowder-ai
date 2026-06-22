import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { FrictionClusterer } from '../../dist/infrastructure/harness-eval/friction/friction-clusterer.js';

// F245 Phase B Task 7 — FrictionClusterer rule 层（关键词归一聚类）
// key = lower(tool) + '|' + 归一(symptom)（去标点/停用词/数字）。同 key → 同 cluster。

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

const clusterer = () => new FrictionClusterer();

describe('FrictionClusterer.clusterByRule (F245 Phase B Task 7)', () => {
  it('① folds N identical (tool+symptom) signals into 1 cluster with count=N', () => {
    const signals = Array.from({ length: 12 }, (_, i) => sig({ id: `s${i}`, rawRef: `m${i}#0` }));
    const clusters = clusterer().clusterByRule(signals);

    assert.equal(clusters.length, 1);
    const c = clusters[0];
    assert.equal(c.count, 12);
    assert.equal(c.members.length, 12);
    assert.equal(c.representative, '噪音大');
    assert.equal(c.method, 'rule');
    assert.deepEqual(c.channels, ['paw-feel']);
    // 成员保留可追溯锚点
    assert.equal(c.members[0].signalId, 's0');
    assert.equal(c.members[0].rawRef, 'm0#0');
    assert.equal(c.members[0].channel, 'paw-feel');
  });

  it('② different tool → does not cluster', () => {
    const clusters = clusterer().clusterByRule([
      sig({ id: 'a', tool: 'rg', symptom: '噪音大' }),
      sig({ id: 'b', tool: 'grep', symptom: '噪音大' }),
    ]);
    assert.equal(clusters.length, 2);
  });

  it('③ cross-channel same problem → 1 cluster with multiple channels (sorted unique)', () => {
    const clusters = clusterer().clusterByRule([
      sig({ id: 'a', tool: 'rg', symptom: '噪音大', channel: 'paw-feel' }),
      sig({ id: 'b', tool: 'rg', symptom: '噪音大', channel: 'cancel' }),
      sig({ id: 'c', tool: 'rg', symptom: '噪音大', channel: 'cancel' }),
    ]);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].count, 3);
    assert.deepEqual(clusters[0].channels, ['cancel', 'paw-feel'], '去重升序');
  });

  it('④ clusterId deterministic = sha1(normalizedKey)[:12]', () => {
    const input = [sig({ id: 'a' }), sig({ id: 'b' })];
    const first = clusterer().clusterByRule(input);
    const second = clusterer().clusterByRule(input);
    assert.equal(first[0].clusterId, second[0].clusterId, '同输入同 clusterId');
    assert.match(first[0].clusterId, /^[a-f0-9]{12}$/);
    // 归一 key = 'rg|噪音大'（tool lower + '|' + normalize(symptom)）
    const expected = createHash('sha1').update('rg|噪音大').digest('hex').slice(0, 12);
    assert.equal(first[0].clusterId, expected);
  });

  it('strips count assignments (×N) as noise → same cluster', () => {
    const clusters = clusterer().clusterByRule([
      sig({ id: 'a', tool: undefined, symptom: 'cancel burst ×3', channel: 'cancel' }),
      sig({ id: 'b', tool: undefined, symptom: 'cancel burst ×5', channel: 'cancel' }),
    ]);
    assert.equal(clusters.length, 1, '×3 与 ×5 剥 count 后同 key');
    assert.equal(clusters[0].count, 2);
  });

  it('cloud R2 P2: preserves identifying digits — different metrics do NOT merge', () => {
    // EvalDomain 发 `${metric}=${count}`，旧版全剥数字会让 m1/m2 都→m 塌一簇（误聚合）
    const metrics = clusterer().clusterByRule([
      sig({ id: 'a', tool: 'C1', symptom: 'm1=1' }),
      sig({ id: 'b', tool: 'C1', symptom: 'm2=2' }),
    ]);
    assert.equal(metrics.length, 2, 'm1 vs m2 不塌成一簇（=count 剥掉但 m1/m2 保留）');

    // 同 metric 不同 count → 仍同簇（count 是噪音）
    const sameMetric = clusterer().clusterByRule([
      sig({ id: 'c', tool: 'C1', symptom: 'm1=1' }),
      sig({ id: 'd', tool: 'C1', symptom: 'm1=9' }),
    ]);
    assert.equal(sameMetric.length, 1, '同 metric 不同 count → 同簇');

    // HTTP 错误码判别性数字保留：401 vs 500 不合并
    const codes = clusterer().clusterByRule([
      sig({ id: 'e', tool: 'curl', symptom: 'http 401' }),
      sig({ id: 'f', tool: 'curl', symptom: 'http 500' }),
    ]);
    assert.equal(codes.length, 2, '401 vs 500 不合并');
  });

  it('representative = most frequent raw symptom among members', () => {
    const clusters = clusterer().clusterByRule([
      sig({ id: 'a', tool: 'rg', symptom: 'noise' }),
      sig({ id: 'b', tool: 'rg', symptom: 'noise' }),
      sig({ id: 'c', tool: 'rg', symptom: 'NOISE' }), // 同归一 key（lowercase），原文不同
    ]);
    assert.equal(clusters.length, 1, 'case-insensitive 同 key');
    assert.equal(clusters[0].representative, 'noise', '最高频原文');
  });

  it('empty input → []', () => {
    assert.deepEqual(clusterer().clusterByRule([]), []);
  });
});
