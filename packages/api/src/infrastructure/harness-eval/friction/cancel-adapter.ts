/**
 * F245 Phase B Task 2 — Cancel 通道采集器 CancelAdapter
 *
 * 只读 task-outcome SQLite store（KD-4：read-model，零写侧改动），把 cancel 类信号映射成
 * 结构化 FrictionSignal。纯 pull 无持久状态。幂等靠 deterministic id（`cancel:${signalRowId}`，
 * SQLite row PK 唯一 → 同源行多次 pull 同 id）。
 *
 * 两道过滤：listSignalsInWindow(['a2','proxy']) 粗筛到含 cancel 的 category，再按
 * `record.type ∈ {permission_cancel, cancel_burst}` 精筛——因为 a2 还含 magic_word_ref /
 * proposal_reject 等非 cancel 信号（粗筛不足，精筛是硬要求）。
 *
 * 字段防御性提取（不走 zod parse throw）：read-model 跨历史 JSON，单条畸形记录不应整窗失败。
 * timestamp 取 store createdAt（窗口过滤列）而非 record.timestamp，保证 signal 时间与所属窗口一致。
 */

import type { FrictionSignal } from '@cat-cafe/shared';
import type { StoredSignal, TaskOutcomeEpisodeStore } from '../task-outcome/task-outcome-store.js';
import type { IFrictionSignalSource } from './friction-signal-source.js';

/** cancel 信号落在的 category（粗筛）：permission_cancel→a2 / cancel_burst→proxy。 */
const CANCEL_CATEGORIES: Array<'a1' | 'a2' | 'proxy'> = ['a2', 'proxy'];

export class CancelAdapter implements IFrictionSignalSource {
  readonly channelId = 'cancel' as const;

  constructor(private readonly store: Pick<TaskOutcomeEpisodeStore, 'listSignalsInWindow'>) {}

  async pull(sinceMs: number, untilMs: number): Promise<FrictionSignal[]> {
    const rows = this.store.listSignalsInWindow(sinceMs, untilMs, CANCEL_CATEGORIES);
    const signals: FrictionSignal[] = [];
    for (const row of rows) {
      const type = row.record.type;
      if (type === 'permission_cancel') signals.push(toPermissionCancelSignal(row));
      else if (type === 'cancel_burst') signals.push(toCancelBurstSignal(row));
      // 其余 a2/proxy 类型（magic_word_ref / proposal_reject / 未来 proxy 类）非 cancel，跳过
    }
    return signals;
  }
}

// ---- record → FrictionSignal 映射（防御性字段提取） ----

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function toPermissionCancelSignal(row: StoredSignal): FrictionSignal {
  const r = row.record;
  const reason = asStr(r.reason);
  const signal: FrictionSignal = {
    id: `cancel:${row.id}`,
    channel: 'cancel',
    timestamp: row.createdAt,
    symptom: reason ? `permission cancel (${reason})` : 'permission cancel',
    rawRef: `${row.id}`,
    severity: 'medium',
  };
  const catId = asStr(r.catId);
  const threadId = asStr(r.threadId);
  const toolName = asStr(r.toolName);
  const paramsSummary = asStr(r.paramsSummary);
  if (catId) signal.catId = catId;
  if (threadId) signal.threadId = threadId;
  if (toolName) signal.tool = toolName;
  if (paramsSummary) signal.sourceEvidence = paramsSummary;
  return signal;
}

function toCancelBurstSignal(row: StoredSignal): FrictionSignal {
  const r = row.record;
  const value = asNum(r.value);
  const signal: FrictionSignal = {
    id: `cancel:${row.id}`,
    channel: 'cancel',
    timestamp: row.createdAt,
    symptom: value !== undefined ? `cancel burst ×${value}` : 'cancel burst',
    rawRef: `${row.id}`,
    severity: 'high',
  };
  const threadId = asStr(r.threadId);
  if (threadId) signal.threadId = threadId;
  return signal;
}
