import { evalDetailCopy } from './eval-workspace/eval-detail.shell-copy';
import { evalWorkspaceCopy } from './eval-workspace/eval-workspace.shell-copy';
import type { EvalHubDiagnosisTarget, EvalHubItem, EvalHubLifecycleView, EvalLifecycleRef } from './HubEvalTypes';

export function lifecycleStatusLabel(
  status: EvalHubLifecycleView['closureStatus'],
  language: 'zh' | 'en' = 'zh',
): string {
  return evalWorkspaceCopy[language].lifecycle[status];
}

export function ownerResponseLabel(
  status: EvalHubLifecycleView['ownerResponseStatus'],
  language: 'zh' | 'en' = 'zh',
): string {
  return evalWorkspaceCopy[language].ownerResponse[status];
}

export function reevalStatusLabel(status: EvalHubLifecycleView['reevalStatus'], language: 'zh' | 'en' = 'zh'): string {
  return status ? evalWorkspaceCopy[language].reevaluation[status] : evalWorkspaceCopy[language].unknownReeval;
}

export function repairDebtLabel(
  status: EvalHubLifecycleView['repairDebtStatus'],
  language: 'zh' | 'en' = 'zh',
): string {
  return evalDetailCopy[language].repairDebt[status ?? 'none'];
}
export function reevalDebtLabel(
  status: EvalHubLifecycleView['reevalDebtStatus'],
  language: 'zh' | 'en' = 'zh',
): string {
  return evalDetailCopy[language].reevalDebt[status ?? 'unknown'];
}

export function formatDiagnosisTarget(target: EvalHubDiagnosisTarget): string {
  return `${target.featureId} / ${target.name}`;
}

export function formatLifecycleOwner(catId: string): string {
  return catId.startsWith('@') ? catId : `@${catId}`;
}

export function escalationLabel(
  escalation: NonNullable<EvalHubLifecycleView['escalation']>,
  language: 'zh' | 'en' = 'zh',
): string {
  return evalDetailCopy[language].escalation[escalation.stage];
}

export function lifecycleRefText(ref: EvalLifecycleRef, language: 'zh' | 'en' = 'zh'): string {
  return ref.availability === 'available'
    ? ref.value
    : evalWorkspaceCopy[language].missingRef(ref.unavailableReason ?? 'unknown');
}

export function currentEvalDueAt(item: Pick<EvalHubItem, 'lifecycle' | 'reeval'>): string | undefined {
  return item.lifecycle.availability === 'available' ? item.lifecycle.reevalDueAt : item.reeval.nextEvalAt;
}

export function formatLifecycleDate(value: string, language: 'zh' | 'en' = 'zh'): string {
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
