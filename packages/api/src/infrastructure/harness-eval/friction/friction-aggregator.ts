/**
 * F245 Phase B Task 6 — FrictionAggregator（4 通道合并 + dedup + intent filter）
 *
 * 注入 N 个 IFrictionSignalSource（Phase B 为 paw-feel / cancel / user-feedback / eval-domain）。
 * collect(window)：并发 pull 各源 → deterministic-id 去重 → 保守 intent filter → 按 timestamp 升序。
 * 无持久状态（KD-5：内存聚合，持久化是 Phase C verdict artifact）。
 *
 * 容错：用 Promise.allSettled（非 Promise.all），单源抛错降级跳过、不整体失败——friction eval
 * 是后台周期任务，一个采集通道挂掉不该让整窗聚合失败。
 */

import type { FrictionChannel, FrictionSignal } from '@cat-cafe/shared';
import type { IFrictionSignalSource } from './friction-signal-source.js';

/** collect 结果：dedup+filter 后的 signals + 抛错被降级跳过的通道（供 rollup 标 degraded，不假装完整）。 */
export interface FrictionCollectResult {
  signals: FrictionSignal[];
  droppedChannels: FrictionChannel[];
}

export class FrictionAggregator {
  constructor(private readonly sources: IFrictionSignalSource[]) {}

  async collect(sinceMs: number, untilMs: number): Promise<FrictionCollectResult> {
    const settled = await Promise.allSettled(this.sources.map((source) => source.pull(sinceMs, untilMs)));

    const byId = new Map<string, FrictionSignal>();
    const droppedChannels: FrictionChannel[] = [];
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status !== 'fulfilled') {
        // 降级跳过抛错的源——但记录通道，rollup 据此标 degraded，不把「少一个通道」当作完整（cloud R3 P2）
        droppedChannels.push(this.sources[i].channelId);
        continue;
      }
      for (const signal of result.value) {
        if (!byId.has(signal.id)) byId.set(signal.id, signal); // deterministic id 去重（首见保留）
      }
    }

    return { signals: [...byId.values()].filter(isGenuineFriction).sort(byTimestampAsc), droppedChannels };
  }
}

/**
 * 升序 by timestamp，id tie-break 保确定性。
 * ⚠️ 用 epoch ms 比较而非字典序——timestamp 可能带时区 offset（EvalDomain 透传 snapshot.generatedAt，
 * bundleSnapshotSchema 允许 `+08:00` 等 offset），字典序只对 canonical `Z` 串成立，混合窗口会排错
 * （cloud R2 P2）。Date.parse 正确归一 offset；解析失败（异常串）回退字典序兜底。
 */
function byTimestampAsc(a: FrictionSignal, b: FrictionSignal): number {
  const ta = Date.parse(a.timestamp);
  const tb = Date.parse(b.timestamp);
  const byTime = Number.isFinite(ta) && Number.isFinite(tb) ? ta - tb : a.timestamp.localeCompare(b.timestamp);
  return byTime || a.id.localeCompare(b.id);
}

/**
 * 保守 intent filter（宁放过不误杀）。**只剔除结构性非信号，不做 intent 分类**
 * （KD-8 feedback_no_classifier_give_data：不用 regex 替猫判断意图）：
 *   1. 空 symptom（任何通道）——零信息的结构性非信号。
 *   2. paw-feel 通道 symptom 引用 lessons 文件（`feedback_xxx`）——文档/元讨论引用而非现场报障。
 *      仅限 paw-feel（猫自由文本）；机器派生通道（cancel/user-feedback/eval-domain）的 metric 名
 *      可能合法含 'feedback'（如 eval metric `feedback_count`），不在此过滤。
 *
 * ⚠️ 不实现 plan 原拟的「symptom 命中 举例/比如」过滤——push-back（evidence）：
 *   (a) KD-8 禁 regex 判 intent；
 *   (b) 失效：PawFeel 的 MARKER_RE 只截 `[爪感差: …]` 括号内，元上下文（"比如"/"举例"）在括号外被剥离，
 *       根本进不了 symptom；
 *   (c) 误杀风险：报「爪感差工具本身的障碍」会被关键词误删，违背宁放过。
 * 真·元引用判定需 thread 类型 / marker 周边上下文 = 信号增强（Phase A producer 或 Phase C），非
 * Phase B signal-level regex。review 请复核此边界。
 */
function isGenuineFriction(signal: FrictionSignal): boolean {
  if (signal.symptom.trim().length === 0) return false;
  if (signal.channel === 'paw-feel' && /feedback_[a-z]/i.test(signal.symptom)) return false;
  return true;
}
