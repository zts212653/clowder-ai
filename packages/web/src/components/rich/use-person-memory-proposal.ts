'use client';

import type { ApprovalHubItem, RichCardBlock } from '@cat-cafe/shared';
import { useCallback, useRef } from 'react';
import { matchHostedApproval } from '@/components/shell/mailbox/approval-match';
import { type PersonMemoryCoordinate, readPersonMemorySource } from './person-memory-proposal-source';
import { useOriginalApprovalRead } from './use-original-approval-read';

export function usePersonMemoryProposal(
  proposalId: string,
  coordinate?: PersonMemoryCoordinate,
  block?: RichCardBlock,
  expectedOwnerUserId?: string,
  enabled = true,
  terminalDetails = false,
) {
  const threadId = coordinate?.threadId,
    messageId = coordinate?.messageId;
  const result = useOriginalApprovalRead(
    'F276',
    proposalId,
    { threadId, messageId, block },
    async (_signal, fresh) =>
      threadId && messageId
        ? readPersonMemorySource(proposalId, { threadId, messageId }, block, undefined, expectedOwnerUserId, fresh)
        : null,
    expectedOwnerUserId,
    enabled,
    terminalDetails,
  );
  const source = result.value ?? null;
  const checked = result.value !== undefined || result.failed;
  const checking = result.reading;
  const current = useRef(source);
  current.current = checking || result.failed ? null : source;
  const refresh = useCallback(
    async (expected?: ApprovalHubItem) => {
      const next = (await result.refresh()) ?? null;
      if (
        expected &&
        (!next?.item ||
          JSON.stringify(expected.detail) !== JSON.stringify(next.item.detail) ||
          matchHostedApproval({
            read: expected,
            readOwnerUserId: expected.ownerUserId,
            storeItems: [next.item],
            now: Date.now(),
          }).kind !== 'matched')
      )
        return null;
      current.current = next;
      return next;
    },
    [result.refresh],
  );
  const beforeWrite = useCallback(async () => {
    const prior = current.current;
    if (!prior?.item) return false;
    const next = await refresh(prior.item);
    return Boolean(
      next?.item &&
        prior.snapshot.undoReceipt?.requestId === next.snapshot.undoReceipt?.requestId &&
        prior.snapshot.decisionReceipt?.decisionId === next.snapshot.decisionReceipt?.decisionId,
    );
  }, [refresh]);
  return {
    source,
    checked,
    checking,
    refresh,
    beforeWrite,
    retained: result.retained,
    reread: result.reread,
    ownerUserId: result.ownerUserId,
  };
}
