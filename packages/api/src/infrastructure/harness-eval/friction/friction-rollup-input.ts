/**
 * F245 Phase B Task 9 — FrictionRollupInput 装配（collect → cluster → 纯函数输入）
 *
 * Finish Line：给定窗口 [sinceMs, untilMs) → FrictionAggregator.collect（4 通道合并 + dedup +
 * intent filter）→ FrictionClusterer.cluster（rule + embedding fail-open）→ 组装成 Phase C rollup
 * 的纯函数输入。无副作用、无持久化（KD-5：持久化是 Phase C verdict artifact）。
 *
 * 不变量：clusters 的成员并集 ⊆ signals（cluster 只折叠 collect 出的 signal，不引入新 signal）。
 */

import type { FrictionRollupInput } from '@cat-cafe/shared';
import type { FrictionAggregator } from './friction-aggregator.js';
import type { FrictionClusterer } from './friction-clusterer.js';

export async function buildFrictionRollupInput(
  aggregator: FrictionAggregator,
  clusterer: FrictionClusterer,
  sinceMs: number,
  untilMs: number,
): Promise<FrictionRollupInput> {
  const { signals, droppedChannels } = await aggregator.collect(sinceMs, untilMs);
  const { clusters, degraded } = await clusterer.cluster(signals);
  // degraded 反映两类不完整：embedding 降级 OR 有采集通道抛错被丢（cloud R3 P2，不假装完整）。
  return {
    window: { sinceMs, untilMs },
    signals,
    clusters,
    degraded: degraded || droppedChannels.length > 0,
    droppedChannels,
  };
}
