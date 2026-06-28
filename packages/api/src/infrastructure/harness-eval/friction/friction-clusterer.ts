/**
 * F245 Phase B Task 7 — FrictionClusterer rule 层（关键词归一聚类）
 *
 * rule 层：按 `lower(tool) + '|' + 归一(symptom)` 精确分组（去标点/停用词/数字）。同 key → 同
 * cluster；clusterId = sha1(归一 key)[:12]（deterministic）。representative = 最高频成员原文 symptom。
 *
 * `clusterByRule` 是稳定公开方法；Task 8 在其之上加 embedding 软聚类（`cluster()` 全管道），
 * 不改本方法签名。纯函数式分组，无持久状态（KD-5 内存聚合）。
 */

import { createHash } from 'node:crypto';
import type { FrictionChannel, FrictionCluster, FrictionSignal } from '@cat-cafe/shared';
import type { IEmbeddingService } from '../../../domains/memory/interfaces.js';

/** 极小英文停用词集（symptom 多为短报障，停用词罕见；中文不分词，短串整体成 token）。 */
const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'on', 'and', 'or']);

/** embedding 软聚类 cosine 阈值默认值（OQ-B2：corpus 调参，写进 test）。 */
const DEFAULT_SIMILARITY_THRESHOLD = 0.82;

/** embedding 层结果：聚类 + degraded 标志（embedding 未就绪/失败 → 仅 rule cluster）。 */
export interface FrictionClusterResult {
  clusters: FrictionCluster[];
  degraded: boolean;
}

export class FrictionClusterer {
  constructor(
    private readonly embedding?: IEmbeddingService,
    private readonly similarityThreshold: number = DEFAULT_SIMILARITY_THRESHOLD,
  ) {}

  /**
   * Rule 层精确归一分组。返回按 count 降序、clusterId 升序的稳定 cluster 列表。
   */
  clusterByRule(signals: FrictionSignal[]): FrictionCluster[] {
    const groups = new Map<string, FrictionSignal[]>();
    for (const signal of signals) {
      const key = clusterKey(signal);
      const bucket = groups.get(key);
      if (bucket) bucket.push(signal);
      else groups.set(key, [signal]);
    }

    const clusters: FrictionCluster[] = [];
    for (const [key, members] of groups) {
      clusters.push({
        clusterId: sha1Hex(key).slice(0, 12),
        representative: pickRepresentative(members),
        channels: uniqueSortedChannels(members),
        count: members.length,
        members: members.map((m) => ({ signalId: m.id, rawRef: m.rawRef, channel: m.channel })),
        method: 'rule',
      });
    }
    return clusters.sort(byCountDescThenClusterId);
  }

  /**
   * 全管道：rule 层 + embedding 软聚类（fail-open）。
   * rule 层未聚的单例经 IEmbeddingService 嵌入后贪心 cosine≥τ 合并（method='embedding'）；
   * 多成员 rule cluster（已被 rule 确证）原样保留。embedding 未注入/未就绪/embed 抛错 →
   * degraded=true，仅返回 rule cluster（fail-open，对齐 memory 域 lexical 降级范式）。
   */
  async cluster(signals: FrictionSignal[]): Promise<FrictionClusterResult> {
    const ruleClusters = this.clusterByRule(signals);
    const embedding = this.embedding;
    if (!embedding) return { clusters: ruleClusters, degraded: true };
    // reprobe/readiness 失败也走 fail-open（与 embed() 抛错同路径）——transient embedding 故障
    // 不该 reject 整个 rollup（cloud R3 P2：旧版 reprobe 在 try 外，rejection 会绕过降级契约）。
    let ready: boolean;
    try {
      await embedding.reprobeIfNeeded();
      ready = embedding.isReady();
    } catch {
      return { clusters: ruleClusters, degraded: true };
    }
    if (!ready) return { clusters: ruleClusters, degraded: true };

    const multi = ruleClusters.filter((c) => c.count > 1);
    const singletons = ruleClusters.filter((c) => c.count === 1);
    if (singletons.length < 2) return { clusters: ruleClusters, degraded: false };

    try {
      const merged = await this.mergeSingletonsByEmbedding(embedding, singletons);
      return { clusters: [...multi, ...merged].sort(byCountDescThenClusterId), degraded: false };
    } catch {
      return { clusters: ruleClusters, degraded: true }; // embed 失败 → fail-open 降级
    }
  }

  /** 单例按 representative 嵌入 → 贪心 cosine≥τ 分组；≥2 成员组合并成 embedding cluster，孤组保留原 rule。 */
  private async mergeSingletonsByEmbedding(
    embedding: IEmbeddingService,
    singletons: FrictionCluster[],
  ): Promise<FrictionCluster[]> {
    const vectors = await embedding.embed(singletons.map((c) => c.representative));
    const groups: Array<{ anchor: Float32Array; clusters: FrictionCluster[] }> = [];
    for (let i = 0; i < singletons.length; i++) {
      const vec = vectors[i];
      const hit = vec ? groups.find((g) => cosine(vec, g.anchor) >= this.similarityThreshold) : undefined;
      if (hit && vec) hit.clusters.push(singletons[i]);
      else groups.push({ anchor: vec ?? new Float32Array(), clusters: [singletons[i]] });
    }
    return groups.map((g) => (g.clusters.length === 1 ? g.clusters[0] : mergeIntoEmbeddingCluster(g.clusters)));
  }
}

// ---- 归一化 + key ----

/** cluster key = lower(tool) + '|' + 归一(symptom)。tool 缺省为空串（tool-less 按 symptom 聚）。 */
function clusterKey(signal: FrictionSignal): string {
  return `${(signal.tool ?? '').toLowerCase()}|${normalizeSymptom(signal.symptom)}`;
}

/**
 * 归一 symptom：lower → 去 count 赋值（`=N` / `×N`，count 是噪音）→ 去标点/符号（保留 Unicode
 * 字母 + 数字）→ 去停用词 → 去重排序。
 * ⚠️ 只剥 count 赋值，**保留判别性数字**（metric `m1` vs `m2`、HTTP `401` vs `500`）——
 * 旧版 `[0-9]+` 全剥会把不同 metric/错误码塌成一簇，反而制造误聚合（cloud R2 P2，违背 AC-B2）。
 */
function normalizeSymptom(symptom: string): string {
  const cleaned = symptom
    .toLowerCase()
    .replace(/[=×]\s*\d+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0 && !STOP_WORDS.has(t));
  return [...new Set(tokens)].sort().join(' ');
}

// ---- cluster 字段派生 ----

function pickRepresentative(members: FrictionSignal[]): string {
  const freq = new Map<string, number>();
  for (const m of members) freq.set(m.symptom, (freq.get(m.symptom) ?? 0) + 1);
  let best = members[0].symptom;
  let bestCount = -1;
  for (const [symptom, count] of freq) {
    if (count > bestCount || (count === bestCount && symptom < best)) {
      best = symptom;
      bestCount = count;
    }
  }
  return best;
}

function uniqueSortedChannels(members: FrictionSignal[]): FrictionChannel[] {
  return [...new Set(members.map((m) => m.channel))].sort();
}

function sha1Hex(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

/** 稳定排序：count 降序（大簇在前，Phase C 排序友好），clusterId 升序 tie-break。 */
function byCountDescThenClusterId(a: FrictionCluster, b: FrictionCluster): number {
  return b.count - a.count || a.clusterId.localeCompare(b.clusterId);
}

// ---- embedding 层 ----

/** 合并 ≥2 个单例 cluster 成 embedding cluster。clusterId=sha1(成员 signalId 升序拼接)[:12]（deterministic）。 */
function mergeIntoEmbeddingCluster(clusters: FrictionCluster[]): FrictionCluster {
  const members = clusters.flatMap((c) => c.members);
  const channels = [...new Set(members.map((m) => m.channel))].sort();
  const signalIds = members.map((m) => m.signalId).sort();
  // 成员均为单例（rule 互不同 key），representative 取字典序最小的原文（确定性）。
  const representative = clusters.map((c) => c.representative).sort()[0];
  return {
    clusterId: sha1Hex(signalIds.join('|')).slice(0, 12),
    representative,
    channels,
    count: members.length,
    members,
    method: 'embedding',
  };
}

/** cosine 相似度；零向量返回 0（避免 NaN）。 */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
