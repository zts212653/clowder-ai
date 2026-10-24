import type { ReactNode } from 'react';
import { ApprovalHostContext, PERMISSIVE_APPROVAL_HOST } from '@/components/ApprovalHost';
import { ApprovalItemCard } from '@/components/ApprovalItemCard';
import { MarkdownContent } from '@/components/MarkdownContent';
import { CardBlock } from '@/components/rich/CardBlock';
import { HandoffCardContent } from '@/components/rich/HandoffCardContent';
import { PersonMemoryOriginal } from '@/components/rich/PersonMemoryOriginal';
import { PersonMemoryRetainedReceipt } from '@/components/rich/PersonMemoryRetainedReceipt';
import { ProfileUpdateCardContent } from '@/components/rich/ProfileUpdateCardContent';
import { ReconciledApprovalResult } from '@/components/rich/ReconciledApprovalResult';
import type { Terminal } from './approval-reconcile';
import type { ApprovalSession } from './approval-sessions';
import { ThreadProposalDecisionReceipt } from './ThreadProposalDecisionReceipt';

/** Shared presentation of the exact session outcome; detail snapshots cannot reopen a writer. */
export function ApprovalDecisionReceipt({
  session,
  terminal,
  line,
  heading,
  children,
  authorizeOpen,
  onExpandedChange,
  deferProducerRead = false,
  resolveThreadId,
}: {
  session: Pick<ApprovalSession, 'approval' | 'ownerUserId' | 'originalBlock'>;
  terminal: Terminal;
  line: string;
  heading?: string;
  children?: ReactNode;
  authorizeOpen?: () => boolean;
  onExpandedChange?: (expanded: boolean) => void;
  deferProducerRead?: boolean;
  resolveThreadId?: () => Promise<string | null>;
}) {
  if (session.approval.sourceFeatureId === 'F276') {
    return (
      <PersonMemoryRetainedReceipt
        approval={session.approval}
        ownerUserId={session.ownerUserId}
        terminal={terminal}
        deferProducerRead={deferProducerRead}
        onExpandedChange={onExpandedChange}
      >
        <ApprovalHostContext.Provider
          value={{
            ...PERMISSIVE_APPROVAL_HOST,
            presentation: 'mailbox',
            writesLocked: true,
            authorizeWrite: () => false,
          }}
        >
          {session.originalBlock ? (
            <div data-testid="approval-receipt-original">
              <PersonMemoryOriginal block={session.originalBlock} />
            </div>
          ) : null}
        </ApprovalHostContext.Provider>
        {children}
      </PersonMemoryRetainedReceipt>
    );
  }
  if (session.approval.sourceFeatureId === 'F128') {
    return (
      <ThreadProposalDecisionReceipt
        approval={session.approval}
        terminal={terminal}
        line={line}
        authorizeOpen={authorizeOpen}
        onExpandedChange={onExpandedChange}
        resolveThreadId={resolveThreadId}
      >
        {children}
      </ThreadProposalDecisionReceipt>
    );
  }
  const approval = session.approval;
  return (
    <ReconciledApprovalResult terminal={terminal} line={line} onExpandedChange={onExpandedChange}>
      {heading ? <MarkdownContent content={heading} className="!text-sm [&_p]:mb-0" disableCommandPrefix /> : null}
      <ApprovalHostContext.Provider
        value={{
          ...PERMISSIVE_APPROVAL_HOST,
          presentation: 'mailbox',
          writesLocked: true,
          authorizeWrite: () => false,
        }}
      >
        {session.originalBlock ? (
          <div data-testid="approval-receipt-original">
            {approval.sourceFeatureId === 'F225' ? (
              <>
                {session.originalBlock.bodyMarkdown ? (
                  <MarkdownContent
                    content={session.originalBlock.bodyMarkdown}
                    className="!text-xs"
                    disableCommandPrefix
                  />
                ) : null}
                <HandoffCardContent fields={session.originalBlock.fields ?? []} />
              </>
            ) : approval.sourceFeatureId === 'F231' ? (
              <ProfileUpdateCardContent block={session.originalBlock} />
            ) : (
              <CardBlock block={{ ...session.originalBlock, actions: undefined }} />
            )}
          </div>
        ) : (
          <ApprovalItemCard
            item={{
              ...approval,
              ownerUserId: session.ownerUserId,
              resolution: terminal.resolution,
              inlineApprovable: false,
            }}
          />
        )}
      </ApprovalHostContext.Provider>
      {children}
    </ReconciledApprovalResult>
  );
}
