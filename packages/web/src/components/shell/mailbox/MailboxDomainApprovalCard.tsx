import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { ApprovalHostContext, PERMISSIVE_APPROVAL_HOST } from '@/components/ApprovalHost';
import { DomainApprovalCard } from '@/components/rich/DomainApprovalCard';
import { OriginalDomainApprovalCard } from '@/components/rich/OriginalDomainApprovalCard';
import { domainApprovalCandidate } from '@/components/rich/read-domain-approval-source';
import { domainApprovalCopy } from '../../rich/domain-approval.shell-copy';
import { useShellCopy } from '../shell-copy';
import { type ApprovalSessions, sessionKey } from './approval-sessions';

/** The same information-card controller as Chat, plus this displayed owner's current read barrier. */
export function MailboxDomainApprovalCard({
  item,
  ownerUserId,
  sessions,
  readCurrent,
  secondaryActions,
}: {
  item: UnifiedAttentionItemV1;
  ownerUserId: string;
  sessions: ApprovalSessions;
  readCurrent: boolean;
  secondaryActions?: ReactNode;
}) {
  const t = useShellCopy(domainApprovalCopy);
  const approval = item.approval,
    proof = item.originalApprovalCard;
  if (!approval) return null;
  const candidate = proof && domainApprovalCandidate(proof.block);
  if (
    !candidate ||
    candidate.feature !== approval.sourceFeatureId ||
    candidate.proposalId !== approval.proposalId ||
    approval.navigation?.state !== 'anchored' ||
    proof?.cardRef.threadId !== approval.navigation.approvalCardRef.threadId ||
    proof.cardRef.messageId !== approval.navigation.approvalCardRef.messageId ||
    proof.cardRef.blockId !== proof.block.id
  ) {
    return (
      <ApprovalHostContext.Provider
        value={{
          ...PERMISSIVE_APPROVAL_HOST,
          presentation: 'mailbox',
          originalPlaceAction: secondaryActions,
          writesLocked: true,
          authorizeWrite: () => false,
        }}
      >
        <DomainApprovalCard item={{ ...approval, ownerUserId }} />
        <p className="text-xs text-[var(--shell-muted)]">{t.unverified}</p>
      </ApprovalHostContext.Provider>
    );
  }
  return (
    <OriginalDomainApprovalCard
      block={proof.block}
      coordinate={proof.cardRef}
      expectedOwnerUserId={ownerUserId}
      secondaryActions={secondaryActions}
      onWriteStart={() => {
        sessions.open({ ownerUserId, decisionRef: item.decisionRef, approval });
      }}
      verifyCurrentRead={() => {
        const current = sessions.currentItem?.(ownerUserId, item.decisionRef);
        return Boolean(
          readCurrent &&
            current &&
            JSON.stringify(current.approval) === JSON.stringify(approval) &&
            JSON.stringify(current.originalApprovalCard) === JSON.stringify(proof),
        );
      }}
      onWriteSettled={() => {
        sessions.open({ ownerUserId, decisionRef: item.decisionRef, approval });
        sessions.reread(sessionKey(ownerUserId, approval));
      }}
    />
  );
}
