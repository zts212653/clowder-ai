'use client';
import type { ApprovalHubItem, RichCardBlock } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { UNIFIED_ATTENTION_INVALIDATION_EVENTS } from '../shell/unified-attention-events';
import { type PersonMemoryCoordinate, readPersonMemorySource } from './person-memory-proposal-source';

export function usePersonMemoryProposal(
  proposalId: string,
  coordinate?: PersonMemoryCoordinate,
  block?: RichCardBlock,
  expectedOwnerUserId?: string,
  enabled = true,
) {
  const [source, setSource] = useState<Awaited<ReturnType<typeof readPersonMemorySource>>>(null);
  const [checked, setChecked] = useState(false),
    [checking, setChecking] = useState(false);
  const current = useRef(source),
    generation = useRef(0);
  const threadId = coordinate?.threadId,
    messageId = coordinate?.messageId;
  const refresh = useCallback(
    async (expected?: ApprovalHubItem) => {
      const round = ++generation.current;
      setChecking(true);
      const next =
        threadId && messageId
          ? await readPersonMemorySource(proposalId, { threadId, messageId }, block, expected, expectedOwnerUserId)
          : null;
      if (round !== generation.current) return null;
      current.current = next;
      setSource(next);
      setChecked(true);
      setChecking(false);
      return next;
    },
    [proposalId, threadId, messageId, block, expectedOwnerUserId],
  );
  useEffect(() => {
    if (!enabled) return;
    current.current = null;
    setSource(null);
    setChecked(false);
    void refresh();
    const invalidate = () => {
      void refresh();
    };
    for (const event of UNIFIED_ATTENTION_INVALIDATION_EVENTS) window.addEventListener(event, invalidate);
    return () => {
      ++generation.current;
      current.current = null;
      for (const event of UNIFIED_ATTENTION_INVALIDATION_EVENTS) window.removeEventListener(event, invalidate);
    };
  }, [refresh, enabled]);
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
  return { source, checked, checking, refresh, beforeWrite };
}
