import type { EvalHubDiagnosisTarget, EvalHubItem, EvalHubLifecycleView, EvalLifecycleRef } from './HubEvalTypes';

const LIFECYCLE_STATUS_LABELS = {
  observing: '持续观察',
  unavailable: '处置记录暂不可用',
  open: '等待接单',
  acknowledged: '已接单',
  action_planned: '已规划修复',
  fix_landed: '修复已落地',
  main_landed: '主干已落地',
  live_active: '运行环境已生效',
  reeval_pending: '等待复评',
  resolved: '已验证闭环',
  suppressed_with_reason: '已说明不处理',
  escalated: '已超时升级',
} satisfies Record<EvalHubLifecycleView['closureStatus'], string>;

const OWNER_RESPONSE_LABELS = {
  not_required: '不需要响应',
  unavailable: '接单状态暂不可读',
  not_started: '等待负责人接单',
  acknowledged: '负责人已接单',
} satisfies Record<EvalHubLifecycleView['ownerResponseStatus'], string>;

const REEVAL_STATUS_LABELS = {
  not_required: '无需复评',
  unavailable: '复评状态不可用',
  not_requested: '尚未提交复评',
  pending: '等待复评',
  passed: '复评通过',
  failed: '复评未通过，已回到修复',
} satisfies Record<NonNullable<EvalHubLifecycleView['reevalStatus']>, string>;

export function lifecycleStatusLabel(status: EvalHubLifecycleView['closureStatus']): string {
  return LIFECYCLE_STATUS_LABELS[status];
}

export function ownerResponseLabel(status: EvalHubLifecycleView['ownerResponseStatus']): string {
  return OWNER_RESPONSE_LABELS[status];
}

export function reevalStatusLabel(status: EvalHubLifecycleView['reevalStatus']): string {
  return status ? REEVAL_STATUS_LABELS[status] : '尚未记录复评状态';
}

export function formatDiagnosisTarget(target: EvalHubDiagnosisTarget): string {
  return `${target.featureId} / ${target.name}`;
}

export function formatLifecycleOwner(catId: string): string {
  return catId.startsWith('@') ? catId : `@${catId}`;
}

export function escalationLabel(escalation: NonNullable<EvalHubLifecycleView['escalation']>): string {
  return escalation.stage === 'acknowledgement' ? '负责人接单已超时' : '复评已超时';
}

export function lifecycleRefText(ref: EvalLifecycleRef): string {
  return ref.availability === 'available' ? ref.value : `缺失：${ref.unavailableReason}`;
}

export function currentEvalDueAt(item: Pick<EvalHubItem, 'lifecycle' | 'reeval'>): string | undefined {
  return item.lifecycle.availability === 'available' ? item.lifecycle.reevalDueAt : item.reeval.nextEvalAt;
}

export function formatLifecycleDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
