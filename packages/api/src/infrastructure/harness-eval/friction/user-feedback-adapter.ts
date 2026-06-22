/**
 * F245 Phase B Task 4 — 用户反馈采集器 UserFeedbackAdapter
 *
 * 只读 F222 confirmed FrustrationIssue（经 listConfirmedInWindow），映射成 FrictionSignal。
 * 纯 pull 无持久状态（KD-4）。幂等靠 deterministic id（`user-feedback:${issueId}`）。
 *
 * 排除 signalType='cancel_burst'：cancel 的全量真相源是 task-outcome（CancelAdapter），F222 的
 * cancel_burst 是稀疏采样——若两通道都采会双计。其余 confirmed 信号（cli_error / text_frustration
 * / a2a_timeout / retry_burst / user_report）是 F222 独有，CancelAdapter 不覆盖，正常采集。
 *
 * timestamp 取 confirmedAt（listConfirmedInWindow 的窗口过滤列），保证 signal 时间落在所属窗口。
 */

import type { FrictionSeverity, FrictionSignal, FrustrationIssue } from '@cat-cafe/shared';
import type { IFrustrationIssueStore } from '../../../domains/cats/services/stores/ports/FrustrationIssueStore.js';
import type { IFrictionSignalSource } from './friction-signal-source.js';

/** cancel 通道全量真相源在 task-outcome；F222 cancel_burst 稀疏采样，排除以免双计。 */
const EXCLUDED_SIGNAL_TYPE = 'cancel_burst';

/** signalType → severity。confirmed 信号已是真摩擦，severity 表相对影响（Phase C 可调，OQ-B4 同源）。 */
const SEVERITY_BY_SIGNAL_TYPE: Record<string, FrictionSeverity> = {
  cli_error: 'high',
  a2a_timeout: 'high',
  retry_burst: 'high',
  text_frustration: 'medium',
  user_report: 'medium',
};

export class UserFeedbackAdapter implements IFrictionSignalSource {
  readonly channelId = 'user-feedback' as const;

  constructor(private readonly store: Pick<IFrustrationIssueStore, 'listConfirmedInWindow'>) {}

  async pull(sinceMs: number, untilMs: number): Promise<FrictionSignal[]> {
    const issues = await this.store.listConfirmedInWindow(sinceMs, untilMs);
    const signals: FrictionSignal[] = [];
    for (const issue of issues) {
      if (issue.signalType === EXCLUDED_SIGNAL_TYPE) continue;
      signals.push(toSignal(issue));
    }
    return signals;
  }
}

// ---- FrustrationIssue → FrictionSignal 映射 ----

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asStrList(v: unknown): string | undefined {
  if (!Array.isArray(v)) return undefined;
  const parts = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * 按 signalType 从 signalDetail 取判别性摘要——字段对齐 FrustrationDetector.evaluate 的真实 shape
 * （a2a_timeout→targetCatId / retry_burst→repeatedPrefix / text_frustration→matchedKeywords /
 * user_report→cancelReason）。缺字段时返回 undefined → 优雅退化为 bare signalType（不臆造）。
 * cli_error 走 publicSummary（toSignal 已处理）；cancel_burst 已在 pull 排除。
 */
function detailSummaryFor(signalType: string, detail: Record<string, unknown>): string | undefined {
  switch (signalType) {
    case 'a2a_timeout':
      return asStr(detail.targetCatId);
    case 'retry_burst':
      return asStr(detail.repeatedPrefix);
    case 'text_frustration':
      return asStrList(detail.matchedKeywords);
    case 'user_report':
      return asStr(detail.cancelReason);
    default:
      return undefined;
  }
}

function toSignal(issue: FrustrationIssue): FrictionSignal {
  const detail = issue.signalDetail;
  // 摘要优先级：userDescription（用户原话）→ publicSummary（cli_error）→ 按 signalType 从 signalDetail
  // 取判别性字段 → 最后才退 bare signalType。否则同类型不同问题（如 a2a_timeout 对不同猫）会在
  // clusterer 的 tool+symptom key 上塌成一个高频簇、丢失 target/cause（cloud R1 P2 + AC-B2 误聚合）。
  const summary =
    asStr(issue.userDescription) ?? asStr(detail.publicSummary) ?? detailSummaryFor(issue.signalType, detail);
  // toolName 是 F222 signalDetail 真实字段（frustration-card-builder 读它）；不臆造 'tool'/'summary' 别名。
  const tool = asStr(detail.toolName);
  const signal: FrictionSignal = {
    id: `user-feedback:${issue.issueId}`,
    channel: 'user-feedback',
    catId: issue.catId,
    threadId: issue.threadId,
    timestamp: new Date(issue.confirmedAt ?? issue.createdAt).toISOString(),
    symptom: summary ? `${issue.signalType}: ${summary}` : issue.signalType,
    rawRef: issue.issueId,
    severity: SEVERITY_BY_SIGNAL_TYPE[issue.signalType] ?? 'medium',
  };
  if (tool) signal.tool = tool;
  if (summary) signal.sourceEvidence = summary;
  return signal;
}
