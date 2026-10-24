import type { ThreadProposal } from '@cat-cafe/shared';
import { useEffect, useMemo, useState } from 'react';
import { type ApprovalHost, ApprovalHostContext, useApprovalHost } from '@/components/ApprovalHost';
import type { PublishedMessageCoordinate } from '@/components/content-review/usePublishedContent';
import { threadProposalCopy } from '@/components/shell/mailbox/thread-proposal.shell-copy';
import { isRecord, readableProposedFields } from '@/components/shell/mailbox/thread-proposal-read';
import { useShellCopy } from '@/components/shell/shell-copy';
import type { RichCardBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
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
  const [proposal, setProposal] = useState<ThreadProposal | null>(null);
  const [checking, setChecking] = useState(true);
  const [verifiedRevision, setVerifiedRevision] = useState(-1);
  const [revision, reread] = useState(0);
  const verified = verifiedRevision === revision;
  useEffect(() => {
    const controller = new AbortController();
    setChecking(true);
    setVerifiedRevision(-1);
    void (async () => {
      try {
        if (!proposalId) return;
        const response = await apiFetch(
          `/api/proposals/${encodeURIComponent(proposalId)}`,
          { signal: controller.signal },
          { afterCurrentGet: true },
        );
        if (!response.ok) return;
        const body: unknown = await response.json();
        const value = isRecord(body) ? body.proposal : null;
        if (!isRecord(value) || value.proposalId !== proposalId || !readableProposedFields(value)) return;
        if (!['pending', 'approving', 'approved', 'rejected', 'withdrawn'].includes(String(value.status))) return;
        if (messageId && value.cardMessageId !== undefined && value.cardMessageId !== messageId) return;
        if (coordinate && value.sourceThreadId !== coordinate.threadId) return;
        if (!controller.signal.aborted) {
          setProposal(value as unknown as ThreadProposal);
          setVerifiedRevision(revision);
        }
      } catch {
        /* unavailable read is shown below; no legacy write fallback */
      } finally {
        if (!controller.signal.aborted) setChecking(false);
      }
    })();
    return () => controller.abort();
  }, [proposalId, messageId, coordinate?.threadId, revision]);
  useEffect(() => {
    const updated = (event: Event) => {
      if ((event as CustomEvent<{ proposalId?: string }>).detail?.proposalId === proposalId) reread((v) => v + 1);
    };
    window.addEventListener('cat-cafe:proposal-updated', updated);
    return () => window.removeEventListener('cat-cafe:proposal-updated', updated);
  }, [proposalId]);
  const host = useMemo<ApprovalHost>(
    () => ({
      ...parent,
      writesLocked: parent.writesLocked || !verified || checking,
      authorizeWrite: (kind, options) => verified && !checking && parent.authorizeWrite(kind, options),
      reportRequest: (event) => {
        parent.reportRequest(event);
        if (event.phase === 'end') reread((value) => value + 1);
      },
    }),
    [parent, verified, checking],
  );
  return (
    <div className="min-w-0">
      {proposal ? (
        <ApprovalHostContext.Provider value={host}>
          <ProposalCardProducer proposal={proposal} showTitle />
        </ApprovalHostContext.Provider>
      ) : null}
      {!verified ? (
        <div className="flex items-center gap-2 text-xs">
          <output>{checking ? t.checking : t.unavailable}</output>
          {!checking ? (
            <button type="button" onClick={() => reread((v) => v + 1)}>
              {t.reread}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
