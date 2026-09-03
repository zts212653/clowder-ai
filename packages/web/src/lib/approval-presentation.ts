import type { ApprovalLifecycleProjection, ApprovalProducerId } from '@cat-cafe/shared';

type ApprovalPresentationItem = {
  sourceFeatureId: ApprovalProducerId;
  summary: string;
};

const SUMMARY_PREFIXES: Partial<Record<ApprovalProducerId, RegExp>> = {
  F128: /^New thread:\s*/iu,
  F139: /^(?:Create|Delete) schedule:\s*/iu,
  F193: /^Work assignment:\s*/iu,
  // Keep the taste dimension; only the type word duplicates the 品味 badge.
  F221: /^Taste\s*/iu,
  F225: /^Session handoff:\s*/iu,
  F231: /^Profile update:\s*/iu,
  F260: /^Entity proposal:\s*/iu,
};

/** UI-only cleanup: the feature badge already owns the proposal kind. */
export function approvalDisplayTitle(item: ApprovalPresentationItem): string {
  const prefix = SUMMARY_PREFIXES[item.sourceFeatureId];
  if (!prefix) return item.summary;
  const title = item.summary.replace(prefix, '').trim();
  return title.length > 0 ? title : item.summary;
}

export function formatApprovalRelativeTime(epochMs: number, now = Date.now()): string {
  const delta = Math.max(0, now - epochMs);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(epochMs).toLocaleDateString('zh-CN');
}

export function formatApprovalAbsoluteTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString('zh-CN');
}

export interface ApprovalLifecyclePresentation {
  label: string;
  tone: 'success' | 'critical' | 'muted';
}

/** The only Hub vocabulary for both active and history renderers. */
export function approvalLifecyclePresentation(item: ApprovalLifecycleProjection): ApprovalLifecyclePresentation {
  if (item.resolution === 'open') return { label: '待决定', tone: 'muted' };
  if (item.resolution === 'rejected') return { label: '已拒绝', tone: 'critical' };
  if (item.resolution === 'closed_without_decision') return { label: '未决定已关闭', tone: 'muted' };
  switch (item.materialization.state) {
    case 'outcome_unknown':
      return { label: '已批准 · 结果待确认', tone: 'muted' };
    case 'in_progress':
      return { label: '已批准 · 执行中', tone: 'muted' };
    case 'succeeded':
      return { label: '已批准 · 已执行', tone: 'success' };
    case 'failed':
      return { label: '已批准 · 执行失败', tone: 'critical' };
    case 'not_started':
      return { label: '已批准', tone: 'success' };
  }
}
