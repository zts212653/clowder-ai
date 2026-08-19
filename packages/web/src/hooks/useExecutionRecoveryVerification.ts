'use client';

import { useMemo } from 'react';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { useThreadLiveness } from './useThreadScopedSelectors';

export interface ExecutionRecoveryVerification {
  /** The canonical snapshot authoritatively describes this thread. */
  readonly canonicalSnapshotCoversThread: boolean;
  /** Canonical truth is settled: an empty execution list can be trusted. */
  readonly canonicalProjectionReady: boolean;
  /** Canonical truth covers the thread but its last sync failed. */
  readonly canonicalProjectionStale: boolean;
  /**
   * The legacy socket still reports a live turn while canonical truth is empty
   * and unsettled. Nothing can confirm or deny that a turn is running, so the
   * UI must keep a recovery exit reachable instead of silently removing it.
   */
  readonly hasUnverifiedLegacyExecution: boolean;
}

/**
 * Single source for "can we verify this thread's run state?".
 *
 * ChatInput and ThreadExecutionBar previously derived this independently. Their
 * answers agreed on the happy path but combined into a trap on the unhappy one:
 * ChatInput hard-locked Cancel to `unavailable` while ThreadExecutionBar removed
 * the force-reset entry, leaving the user with no exit at all. Two components
 * answering the same question must answer it from the same place.
 *
 * Pass `threadId` for an explicitly scoped surface (split view). When it is
 * absent the caller's own unscoped liveness wins: ChatInput receives that as a
 * prop from its container, which is NOT always the store's raw flag, so it is
 * passed in explicitly rather than re-read here.
 */
export function useExecutionRecoveryVerification(
  threadId: string | undefined,
  unscopedLegacyActive?: boolean,
): ExecutionRecoveryVerification {
  const currentThreadId = useChatStore((state) => state.currentThreadId);
  const unscopedHasActiveInvocation = useChatStore((state) => state.hasActiveInvocation);
  const effectiveThreadId = threadId ?? currentThreadId;
  const { hasActive: scopedHasActiveInvocation } = useThreadLiveness(effectiveThreadId);
  const effectiveThreadProjectPath = useChatStore(
    (state) => state.threads.find((candidate) => candidate.id === effectiveThreadId)?.projectPath ?? null,
  );
  const executionAnchorThreadId = useActiveExecutionStore((state) => state.anchorThreadId);
  const executionProjectPath = useActiveExecutionStore((state) => state.projectPath);
  const executionHydration = useActiveExecutionStore((state) => state.hydration);
  const executionsByKey = useActiveExecutionStore((state) => state.executionsByKey);
  // Counted here rather than accepted as a parameter: callers previously supplied
  // this and immediately diverged — ThreadExecutionBar passed every execution kind
  // while ChatInput passed live invocations only, so "one shared answer" was still
  // two answers with one function in between. `live_invocation` is the semantics the
  // cancel/recovery surfaces actually reason about.
  const canonicalExecutionCount = useMemo(
    () =>
      Object.values(executionsByKey).filter(
        (execution) => execution.threadId === effectiveThreadId && execution.kind === 'live_invocation',
      ).length,
    [executionsByKey, effectiveThreadId],
  );

  const legacyHasActiveInvocation = threadId
    ? scopedHasActiveInvocation
    : (unscopedLegacyActive ?? unscopedHasActiveInvocation);
  // The endpoint returns a project-wide snapshot. In split view its route anchor
  // can be thread A while the surface targets same-project thread B; that
  // snapshot still authoritatively covers B. A different/unknown project remains
  // fail-closed until its own projection is hydrated.
  const canonicalSnapshotCoversThread =
    executionAnchorThreadId === effectiveThreadId ||
    (executionProjectPath !== null && executionProjectPath === effectiveThreadProjectPath);
  const canonicalProjectionReady = canonicalSnapshotCoversThread && executionHydration === 'ready';
  const canonicalProjectionStale = canonicalSnapshotCoversThread && executionHydration === 'error';

  return {
    canonicalSnapshotCoversThread,
    canonicalProjectionReady,
    canonicalProjectionStale,
    hasUnverifiedLegacyExecution: Boolean(
      legacyHasActiveInvocation && canonicalExecutionCount === 0 && !canonicalProjectionReady,
    ),
  };
}
