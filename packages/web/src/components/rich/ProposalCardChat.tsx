import type { ThreadProposal } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef } from 'react';
import { type ApprovalHost, ApprovalHostContext, useApprovalHost } from '@/components/ApprovalHost';
import type { PublishedMessageCoordinate } from '@/components/content-review/usePublishedContent';
import { SettledApprovalReceipt } from '@/components/shell/mailbox/SettledApprovalReceipt';
import type { SettledResultItem } from '@/components/shell/mailbox/settled-results-source';
import { threadProposalCopy } from '@/components/shell/mailbox/thread-proposal.shell-copy';
import { isRecord, readableProposedFields } from '@/components/shell/mailbox/thread-proposal-read';
import { useShellCopy } from '@/components/shell/shell-copy';
import { fetchApprovalProducerBody } from '@/lib/approval-producer-read';
import { approvalResultRead } from '@/lib/approval-result-read';
import { useApprovalResult } from '@/lib/use-approval-result';
import type { RichCardBlock } from '@/stores/chat-types';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import { ProposalCardProducer } from './ProposalCardProducer';
import { extractProposalId } from './ProposalCardUtils';

/** The original owner-fenced GET supplies the display; a historical block never supplies write authority. */
export function ProposalCardChat({
  block,
  messageId,
  coordinate,
}: {
  block: RichCardBlock;
  messageId?: string;
  coordinate?: PublishedMessageCoordinate;
}) {
  const proposalId = extractProposalId(block);
  const key = `${coordinate?.threadId ?? ''}|${messageId ?? ''}|${proposalId}`;
  return <ChatProposalRead key={key} proposalId={proposalId} messageId={messageId} coordinate={coordinate} />;
}

function ChatProposalRead({
  proposalId,
  messageId,
  coordinate,
}: {
  proposalId: string | null;
  messageId?: string;
  coordinate?: PublishedMessageCoordinate;
}) {
  const t = useShellCopy(threadProposalCopy);
  const parent = useApprovalHost();
  const readAtWriteStart = useRef<object | null>(null);
  const observed = useApprovalResult<SettledResultItem | null>(
    'F128',
    proposalId,
    'settled',
    async () => null,
    undefined,
    false,
  );
  const candidate = observed.value;
  const retained =
    candidate &&
    candidate.ownerUserId === observed.ownerUserId &&
    candidate.proposalId === proposalId &&
    candidate.sourceFeatureId === 'F128' &&
    candidate.navigation.state === 'anchored' &&
    !!messageId &&
    candidate.navigation.approvalCardRef.messageId === messageId &&
    (!coordinate || candidate.navigation.approvalCardRef.threadId === coordinate.threadId) &&
    (candidate.resolution !== 'accepted' || candidate.materialization.state === 'succeeded')
      ? candidate
      : null;
  const result = useApprovalResult(
    'F128',
    proposalId,
    'native',
    (signal) =>
      fetchApprovalProducerBody(
        { owner: apiSessionIdentity.getSnapshot().ownerUserId ?? '', producer: 'F128', proposalId: proposalId ?? '' },
        `/api/proposals/${encodeURIComponent(proposalId ?? '')}`,
        signal,
      ),
    undefined,
    !retained,
  );
  const body = result.value;
  const value = isRecord(body) ? body.proposal : null;
  const proposal =
    isRecord(value) &&
    value.proposalId === proposalId &&
    value.createdBy === result.ownerUserId &&
    readableProposedFields(value) &&
    ['pending', 'approving', 'approved', 'rejected', 'withdrawn'].includes(String(value.status)) &&
    (!messageId || value.cardMessageId === undefined || value.cardMessageId === messageId) &&
    (!coordinate || value.sourceThreadId === coordinate.threadId)
      ? (value as unknown as ThreadProposal)
      : null;
  const verified = retained !== null || (proposal !== null && !result.failed);
  const checking = result.reading;
  useEffect(() => {
    if (proposal && ['rejected', 'withdrawn'].includes(proposal.status) && result.ownerUserId)
      approvalResultRead.terminal({ owner: result.ownerUserId, producer: 'F128', proposalId: proposal.proposalId });
  }, [proposal, result.ownerUserId]);
  const host = useMemo<ApprovalHost>(
    () => ({
      ...parent,
      writesLocked: parent.writesLocked || !verified || checking,
      authorizeWrite: (kind, options) => verified && !checking && parent.authorizeWrite(kind, options),
      reportRequest: (event) => {
        const key =
          result.ownerUserId && proposalId ? { owner: result.ownerUserId, producer: 'F128', proposalId } : null;
        if (event.phase === 'start' && key) readAtWriteStart.current = approvalResultRead.snapshot(key, 'native');
        parent.reportRequest(event);
        if (event.phase === 'end') {
          const before = readAtWriteStart.current;
          readAtWriteStart.current = null;
          const current = key ? approvalResultRead.snapshot(key, 'native') : null;
          // The source's write event may already have started/completed this read. Keep that same attempt.
          if (!before || before === current || current?.failed) void result.refresh();
        }
      },
    }),
    [parent, verified, checking, result.refresh, result.ownerUserId, proposalId],
  );
  return (
    <div className="min-w-0">
      {retained ? (
        <SettledApprovalReceipt
          item={retained}
          reread={() => approvalResultRead.invalidate({ producer: 'F128', proposalId: retained.proposalId })}
          authorizeOpen={() => apiSessionIdentity.getSnapshot().ownerUserId === retained.ownerUserId}
        />
      ) : proposal ? (
        <ApprovalHostContext.Provider value={host}>
          <ProposalCardProducer proposal={proposal} showTitle />
        </ApprovalHostContext.Provider>
      ) : null}
      {!verified ? (
        <div className="flex items-center gap-2 text-xs">
          <output>{checking ? t.checking : t.unavailable}</output>
          {!checking ? (
            <button type="button" onClick={result.refresh}>
              {t.reread}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
