import type { PawFeelInboxItem } from '@cat-cafe/shared';
import { pawFeelDutyCopy } from './paw-feel-duty.shell-copy';

function responsibilityDetail(item: PawFeelInboxItem, language: 'zh' | 'en'): string | undefined {
  const t = pawFeelDutyCopy[language];
  switch (item.responsibility.exitKind) {
    case 'signature_request':
      return t.signature(
        item.responsibility.signerExclusionCatId ?? 'unknown',
        item.responsibility.preferredSignerCatId ?? '',
      );
    case 'explicit_blocker':
      return t.blocker(item.responsibility.blocker?.code ?? 'unknown', item.responsibility.blocker?.ref ?? '');
    case 'pending_proposal':
      return t.proposal(item.responsibility.proposalId ?? 'unavailable');
    default:
      return undefined;
  }
}

function dispositionDetail(item: PawFeelInboxItem, language: 'zh' | 'en'): string | undefined {
  const t = pawFeelDutyCopy[language];
  const { disposition } = item;
  switch (disposition.state) {
    case 'routed':
      return t.routed(disposition.targetThreadId ?? disposition.proposalId ?? t.responsibilitySurface);
    case 'route_pending':
      return disposition.targetThreadId
        ? t.pending(disposition.targetThreadId)
        : t.staleProposal(disposition.proposalId ?? 'unavailable');
    case 'duplicate':
      return disposition.duplicateOf ? t.duplicate(disposition.duplicateOf) : undefined;
    case 'fix': {
      if (disposition.repairBinding?.kind === 'task_assignment') {
        const detail = t.assignment(disposition.ownerCatId ?? 'unknown', disposition.taskId ?? 'unavailable');
        return item.responsibility.validExit ? detail : `${detail} · ${t.failedAssignment}`;
      }
      const binding = t.binding(
        disposition.ownerCatId ?? 'unknown',
        disposition.taskId ?? 'unavailable',
        disposition.actionLeaseRef?.leaseId ?? 'unavailable',
      );
      return item.responsibility.validExit ? binding : `${binding} · ${t.failedLease}`;
    }
    default:
      return disposition.reasonCode ? t.reason(disposition.reasonCode) : undefined;
  }
}

export function pawFeelDutyDetail(item: PawFeelInboxItem, language: 'zh' | 'en' = 'zh'): string | undefined {
  return responsibilityDetail(item, language) ?? dispositionDetail(item, language);
}
