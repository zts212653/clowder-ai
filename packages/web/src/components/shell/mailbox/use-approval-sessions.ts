'use client';

import { useEffect, useRef, useState } from 'react';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import type { UnifiedAttentionView } from '../use-unified-attention';
import { type ApprovalSessions, createApprovalSessions } from './approval-sessions';

/**
 * F322 S3-2b-1c: the React side of the approval sessions. One driver for as long as the caller lives (the rail button, which
 * also owns the read: a session must outlive the panel and the row it was opened from). It feeds the driver what only
 * React and the store know:
 *  - the Approval Hub store's attempt records, whenever they change;
 *  - the moment a unified read has settled and React has committed it;
 *  - the read hook's live count of reads started, so "a newer read is on its way" is true the instant it starts and not
 *    only after the next render (a press that lands in between must see it).
 */
export function useApprovalSessions(view: UnifiedAttentionView): ApprovalSessions {
  const viewRef = useRef(view);
  const [sessions] = useState(() =>
    createApprovalSessions({
      readsStarted: () => viewRef.current.readsStarted(),
      refetch: () => viewRef.current.refetch(),
      refreshStore: () => useApprovalHubStore.getState().fetchPending(),
      storeItems: () => useApprovalHubStore.getState().items,
      attempts: () => useApprovalHubStore.getState().decisionAttempts,
      latestRead: () => {
        const current = viewRef.current;
        // The read behind `result` is current only while no newer one has started. A newer read in flight is not a result.
        if (current.resultGeneration === null || current.resultGeneration !== current.readsStarted()) {
          return { result: { kind: 'loading' }, generation: null };
        }
        return { result: current.result, generation: current.resultGeneration };
      },
      now: () => Date.now(),
    }),
  );

  // Declared first, so every effect below sees the view of the render that was just committed.
  useEffect(() => {
    viewRef.current = view;
  });

  const { result, resultGeneration } = view;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a settled read is exactly a new (result, generation) pair
  useEffect(() => {
    sessions.readSettled();
  }, [sessions, result, resultGeneration]);

  useEffect(
    () =>
      useApprovalHubStore.subscribe((state, previous) => {
        if (state.decisionAttempts !== previous.decisionAttempts) sessions.attemptsChanged();
      }),
    [sessions],
  );

  return sessions;
}
