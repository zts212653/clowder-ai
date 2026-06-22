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
 * **effective order time**（deliveredAt ?? timestamp）排序——RedisMessageStore 的 TIMELINE zset
 * 满足（markDelivered re-score 到 deliveredAt）。friction eval 是后台周期任务，数据源恒为生产
 * Redis，契约满足。in-memory MessageStore 的 getBefore 按 raw timestamp 排序游标，仅 degraded/
 * test mode 用且不运行 friction rollup；误注入时 collectWindow 的 seen-id 去重 + 无进展 break
 * 保证 graceful degrade（不重复 / 不死循环，但 queued-delivered message 可能漏采）。
 */

import type { FrictionSignal } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import type { IFrictionSignalSource } from './friction-signal-source.js';
import { extractPawFeelMarkers, type PawFeelMarker } from './paw-feel-marker.js';

const DEFAULT_PAGE_SIZE = 200;

export interface PawFeelAdapterOptions {
  /** 全局 timeline 翻页大小（默认 200）。测试可调小以验证翻页收集完整。 */
  pageSize?: number;
}

interface PageCursor {
  ts: number;
  id: string;
}

export class PawFeelAdapter implements IFrictionSignalSource {
  readonly channelId = 'paw-feel' as const;

  constructor(
    private readonly messageStore: Pick<IMessageStore, 'getBefore'>,
    private readonly options: PawFeelAdapterOptions = {},
  ) {}

  async pull(sinceMs: number, untilMs: number): Promise<FrictionSignal[]> {
    const messages = await this.collectWindow(sinceMs, untilMs);
    const signals: FrictionSignal[] = [];
    for (const msg of messages) {
      // author guard：爪感差是猫的摩擦上报约定（L0 staging），跳过 user-authored——
      // user/讨论消息引用 marker 格式不是真信号（gpt52 review P1-2）
      if (!msg.catId) continue;
      extractPawFeelMarkers(msg.content).forEach((marker, idx) => {
        signals.push(toSignal(msg, marker, idx));
      });
    }
    return signals;
  }

  /**
   * 全局 timeline 游标翻页收集 [sinceMs, untilMs) 内全部 message（recall=100%）。
   * getBefore(userId=undefined) → 全局 TIMELINE zset，返回 score < 上界、升序（最老在前）。
   */
  private async collectWindow(sinceMs: number, untilMs: number): Promise<StoredMessage[]> {
    const pageSize = this.options.pageSize ?? DEFAULT_PAGE_SIZE;
    const collected: StoredMessage[] = [];
    const seen = new Set<string>();
    let cursor: PageCursor | undefined;
    for (;;) {
      const page = await this.fetchBefore(cursor, untilMs, pageSize);
      if (page.length === 0) break;
      const fresh = absorbPage(page, seen, collected, sinceMs, untilMs);
      const oldest = page[0]; // 升序 → page[0] 最老
      // fresh===0 = 本页全已见 = 翻页无进展，避免 in-memory getBefore 的 raw-timestamp cursor
      // 语义（vs Redis effective zset score）让 queued-delivered message 重复/死循环（cloud R3 P2）；
      // 或穿过窗口下界（effective order time）；或本页不满 = 无更多 → 停止翻页
      if (!oldest || fresh === 0 || effectiveTs(oldest) < sinceMs || page.length < pageSize) break;
      cursor = nextCursor(oldest);
    }
    return collected;
  }

  /** 取下一页：有游标走复合游标路径，否则用 untilMs 作上界（全局 TIMELINE）。
   *  返回 union 如实反映 IMessageStore.getBefore 的 sync-or-async 签名；caller await 吞之。 */
  private fetchBefore(
    cursor: PageCursor | undefined,
    untilMs: number,
    pageSize: number,
  ): StoredMessage[] | Promise<StoredMessage[]> {
    return cursor
      ? this.messageStore.getBefore(cursor.ts, pageSize, undefined, cursor.id)
      : this.messageStore.getBefore(untilMs, pageSize, undefined);
  }
}

/**
 * effective order time——对齐 RedisMessageStore timeline zset score：append 时 score=timestamp，
 * markDelivered 后 re-score 到 deliveredAt。窗口判定/游标/输出全程用它，避免 queued 消息
 * （created 在窗口前但 delivered 在窗口内）被 raw timestamp 漏采（gpt52 review P1-1）。
 */
function effectiveTs(msg: StoredMessage): number {
  return msg.deliveredAt ?? msg.timestamp;
}

/** 时间窗判定：[sinceMs, untilMs)，sinceMs 含、untilMs 不含（按 effective order time）。 */
function inWindow(msg: StoredMessage, sinceMs: number, untilMs: number): boolean {
  const ts = effectiveTs(msg);
  return ts >= sinceMs && ts < untilMs;
}

/**
 * 吸收一页：seen-id 去重 + 窗口过滤进 collected，返回本页「新见」message 数（0 = 翻页无进展）。
 * seen 去重让翻页对 store cursor 语义不敏感（Redis effective vs in-memory raw timestamp），
 * 配合 collectWindow 的 fresh===0 break 杜绝 queued-delivered message 重复采集 / 死循环。
 */
function absorbPage(
  page: StoredMessage[],
  seen: Set<string>,
  collected: StoredMessage[],
  sinceMs: number,
  untilMs: number,
): number {
  let fresh = 0;
  for (const msg of page) {
    if (seen.has(msg.id)) continue;
    seen.add(msg.id);
    fresh++;
    if (inWindow(msg, sinceMs, untilMs)) collected.push(msg);
  }
  return fresh;
}

/** 下一页游标：用 effective order time，对齐 zset score 语义。 */
function nextCursor(msg: StoredMessage): PageCursor {
  return { ts: effectiveTs(msg), id: msg.id };
}

/** 把一条 message 内的单个 marker 组装成 FrictionSignal。 */
function toSignal(msg: StoredMessage, marker: PawFeelMarker, idx: number): FrictionSignal {
  const rawRef = `${msg.id}#${idx}`;
  const signal: FrictionSignal = {
    id: `paw-feel:${rawRef}`,
    channel: 'paw-feel',
    threadId: msg.threadId,
    timestamp: new Date(effectiveTs(msg)).toISOString(),
    symptom: marker.symptom,
    rawRef,
    severity: 'medium',
    sourceEvidence: marker.raw,
  };
  // 条件赋值：optional 字段无值时不设（兼容 exactOptionalPropertyTypes）
  if (msg.catId) signal.catId = msg.catId;
  if (marker.tool) signal.tool = marker.tool;
  return signal;
}
