import type { PawFeelInboxItem } from '@cat-cafe/shared';
import { pawFeelCopy } from './paw-feel.shell-copy';

export function pawFeelIssueStatus(item: PawFeelInboxItem, language: 'zh' | 'en' = 'zh'): string {
  const t = pawFeelCopy[language];
  const resolution = item.issue.resolution === 'resolved' ? t.issueResolved : t.issueOpen;
  return `${resolution} · ${t.continuations[item.issue.continuation.kind]}`;
}

export function pawFeelContinuationLabel(
  kind: PawFeelInboxItem['issue']['continuation']['kind'],
  language: 'zh' | 'en' = 'zh',
): string {
  return pawFeelCopy[language].continuations[kind];
}

export function pawFeelIssueDetail(item: PawFeelInboxItem, language: 'zh' | 'en' = 'zh'): string | undefined {
  const t = pawFeelCopy[language];
  const continuation = item.issue.continuation;
  const parts: string[] = [];
  if (continuation.canonicalSignalId) parts.push(`${t.originalIssue} ${continuation.canonicalSignalId}`);
  if (continuation.ownerCatId) parts.push(`owner @${continuation.ownerCatId}`);
  if (continuation.taskId) parts.push(`${t.task} ${continuation.taskId}`);
  if (continuation.repairBinding?.kind === 'task_assignment')
    parts.push(`Task assignment ${continuation.repairBinding.ownerRevision}`);
  if (continuation.leaseId) parts.push(`F167 lease ${continuation.leaseId}`);
  if (continuation.proposalId) parts.push(`Approval ${continuation.proposalId}`);
  if (continuation.caseActionRef) parts.push(`case action ${continuation.caseActionRef}`);
  if (continuation.reasonCode) parts.push(`${t.reason} ${continuation.reasonCode}`);
  if (item.issue.resumeAt) parts.push(`${t.earliestResume} ${item.issue.resumeAt}`);
  if (continuation.evidenceRefs.length > 0) {
    parts.push(`${t.evidence} ${continuation.evidenceRefs.join(language === 'en' ? ', ' : '、')}`);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
