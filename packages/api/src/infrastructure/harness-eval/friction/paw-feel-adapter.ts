/**
 * F245 Phase A Task3 — 爪感差采集器 PawFeelAdapter
 *
 * 回扫全局 message timeline，把 `[爪感差: …]` marker 提取成结构化 FrictionSignal。
 * 纯 pull 无持久状态（KD-4）。幂等靠 deterministic id（`paw-feel:${messageId}#${idx}`）。
 *
 * 数据获取：用 IMessageStore.getBefore(untilMs, …, userId=undefined) 走全局 TIMELINE
 * zset 游标翻页扫整个时间窗——无需枚举 thread（IThreadStore 仅 per-user，无全局枚举）。
 * 游标范式对齐 collectAllThreadMessages（thread-artifacts-aggregator）。
 *
 * ⚠️ Store 契约（cloud review R3 P2）：完整 recall 要求 message store 的 getBefore 游标按
 * **timeline order time** 排序——real-cat speech 用 authoring time，ordinary queued work 用
 * deliveredAt。RedisMessageStore 的 TIMELINE zset 与 `getTimelineOrderTime` 同口径。friction eval 数据源恒为生产
 * Redis，契约满足。in-memory MessageStore 的 getBefore 按 raw timestamp 排序游标，仅 degraded/
 * test mode 用且不运行 friction rollup；误注入时 collectWindow 的 seen-id 去重 + 无进展 break
 * 保证 graceful degrade（不重复 / 不死循环，但 queued-delivered message 可能漏采）。
 */

import type { FrictionSignal } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import { getTimelineOrderTime } from '../../../domains/cats/services/stores/visibility.js';
import type { IFrictionSignalSource } from './friction-signal-source.js';
import { type CanonicalPawFeelCandidate, collectPawFeelMessages, inspectPawFeelMessage } from './paw-feel-source.js';

export interface PawFeelAdapterOptions {
  /** 全局 timeline 翻页大小（默认 200）。测试可调小以验证翻页收集完整。 */
  pageSize?: number;
}

export class PawFeelAdapter implements IFrictionSignalSource {
  readonly channelId = 'paw-feel' as const;

  constructor(
    private readonly messageStore: Pick<IMessageStore, 'getBefore'>,
    private readonly options: PawFeelAdapterOptions = {},
  ) {}

  async pull(sinceMs: number, untilMs: number): Promise<FrictionSignal[]> {
    const messages = await collectPawFeelMessages(this.messageStore, sinceMs, untilMs, this.options);
    const signals: FrictionSignal[] = [];
    for (const msg of messages) {
      const inspection = inspectPawFeelMessage(msg);
      if (inspection.kind === 'ignored') continue;
      if (inspection.kind === 'cross_post_copy') {
        if (msg.catId) signals.push(toCrossPostRoutingSignal(msg, inspection.markerCount, msg.catId));
        continue;
      }
      signals.push(...inspection.candidates.map(toSignal));
    }
    return signals;
  }
}

/**
 * Timeline order time——对齐 RedisMessageStore timeline zset score。Real-cat speech
 * stays at authoring time; ordinary queued work moves to delivery time.
 */
function effectiveTs(msg: StoredMessage): number {
  return getTimelineOrderTime(msg);
}

/** 把一条 message 内的单个 marker 组装成 FrictionSignal。 */
function toSignal(candidate: CanonicalPawFeelCandidate): FrictionSignal {
  const rawRef = `${candidate.sourceMessageId}#${candidate.markerIndex}`;
  const signal: FrictionSignal = {
    id: `paw-feel:${rawRef}`,
    channel: 'paw-feel',
    threadId: candidate.sourceThreadId,
    timestamp: candidate.occurredAt,
    symptom: candidate.marker.symptom,
    rawRef,
    severity: 'medium',
    sourceEvidence: candidate.marker.raw,
  };
  // 条件赋值：optional 字段无值时不设（兼容 exactOptionalPropertyTypes）
  signal.catId = candidate.sourceCatId;
  if (candidate.marker.tool) signal.tool = candidate.marker.tool;
  return signal;
}

/**
 * A copied marker is not a second report of the source symptom. Preserve one
 * deterministic eval signal about the routing misuse, then discard the copied
 * symptom(s). This keeps legacy/direct-API bypasses observable after the MCP
 * boundary starts rejecting new copies.
 */
function toCrossPostRoutingSignal(msg: StoredMessage, markerCount: number, catId: string): FrictionSignal {
  const rawRef = `${msg.id}#cross-post-routing`;
  return {
    id: `paw-feel:${rawRef}`,
    channel: 'paw-feel',
    catId,
    threadId: msg.threadId,
    timestamp: new Date(effectiveTs(msg)).toISOString(),
    tool: 'cat_cafe_cross_post_message',
    symptom: 'paw-feel marker was copied across threads instead of referencing its source message',
    rawRef,
    severity: 'medium',
    sourceEvidence: `${markerCount} copied marker(s) from ${msg.extra?.crossPost?.sourceThreadId ?? 'unknown source'}`,
  };
}
