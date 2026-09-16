import type { PawFeelInboxItem } from '@cat-cafe/shared';

const CONTINUATION_LABELS: Record<PawFeelInboxItem['issue']['continuation']['kind'], string> = {
  review_required: '等待责任审阅',
  route_pending: '等待责任路由',
  signature_required: '等待独立签署',
  repair_active: '修复进行中',
  done_unverified: '任务已结束，等待 owner 验证',
  repair_interrupted: '修复已中断，等待恢复',
  direct_route_blocked: '修复授权路径需重新校验',
  approval_required: '等待权限批准',
  dispatch_pending: '权限已批，等待派工',
  analysis_required: '等待分析并建立修复路径',
  analysis_ambiguous: '分析关联冲突，需消歧',
  analysis_stale: '分析关联已过期，需刷新',
  observe: '继续观察并按期复评',
  blocked: '等待恢复条件',
  legacy_blocker_unbound: '历史阻塞尚未绑定恢复条件',
  duplicate_following: '跟随原问题进度',
  verified_outcome: 'owner 结果已验证',
  no_action: '有理由地无需处理',
};

export function pawFeelIssueStatus(item: PawFeelInboxItem): string {
  const resolution = item.issue.resolution === 'resolved' ? '问题已解决' : '问题仍开放';
  return `${resolution} · ${CONTINUATION_LABELS[item.issue.continuation.kind]}`;
}

export function pawFeelContinuationLabel(kind: keyof typeof CONTINUATION_LABELS): string {
  return CONTINUATION_LABELS[kind];
}

export function pawFeelIssueDetail(item: PawFeelInboxItem): string | undefined {
  const continuation = item.issue.continuation;
  const parts: string[] = [];
  if (continuation.canonicalSignalId) parts.push(`原问题 ${continuation.canonicalSignalId}`);
  if (continuation.ownerCatId) parts.push(`owner @${continuation.ownerCatId}`);
  if (continuation.taskId) parts.push(`任务 ${continuation.taskId}`);
  if (continuation.leaseId) parts.push(`F167 lease ${continuation.leaseId}`);
  if (continuation.proposalId) parts.push(`Approval ${continuation.proposalId}`);
  if (continuation.caseActionRef) parts.push(`case action ${continuation.caseActionRef}`);
  if (continuation.reasonCode) parts.push(`原因 ${continuation.reasonCode}`);
  if (item.issue.resumeAt) parts.push(`最早恢复 ${item.issue.resumeAt}`);
  if (continuation.evidenceRefs.length > 0) {
    parts.push(`证据 ${continuation.evidenceRefs.join('、')}`);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
