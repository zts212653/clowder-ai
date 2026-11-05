import { useCallback, useEffect, useRef, useState } from 'react';
import { type Thread, useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import {
  canCommitFirstRealMessage,
  type FirstRealMessageSyncAction,
  firstRealMessageSyncAction,
  markFirstRealMessage,
  type OnboardingJourneyState,
  restoreFirstRealMessagePendingMarker,
  restoreJourneyState,
} from './onboarding-journey';
import { syncLocalBootcampState } from './syncLocalBootcampState';
import { useFirstRealMessageRetry } from './useFirstRealMessageRetry';

const JOURNEY_STORAGE_KEY = 'cat-cafe:onboarding-journey';
const PENDING_STORAGE_KEY = 'cat-cafe:onboarding-first-real-message-pending';

type BootcampState = NonNullable<Thread['bootcampState']>;

interface FirstRealMessageSyncContext {
  journey: OnboardingJourneyState;
  bootcampState: Thread['bootcampState'];
  action: FirstRealMessageSyncAction;
}

interface UseFirstRealMessageSyncOptions {
  threadId: string;
  currentBootcampState: Thread['bootcampState'];
  onboardingSyncError: boolean;
  setOnboardingSyncError: (value: boolean) => void;
  setShowOnboardingHint: (value: boolean) => void;
}

function persistPendingMarker(journeyId: string, threadId: string): void {
  localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify({ journeyId, threadId }));
}

function clearPendingMarker(): void {
  localStorage.removeItem(PENDING_STORAGE_KEY);
}

function readSyncContext(threadId: string): FirstRealMessageSyncContext | null {
  try {
    const journey = restoreJourneyState(localStorage.getItem(JOURNEY_STORAGE_KEY));
    if (!journey || journey.stage !== 'ready' || (journey.threadId && journey.threadId !== threadId)) return null;
    const hydratedThread = useChatStore.getState().threads.find((thread) => thread.id === threadId);
    return {
      journey,
      bootcampState: hydratedThread?.bootcampState,
      action: firstRealMessageSyncAction(journey, hydratedThread?.bootcampState),
    };
  } catch {
    return null;
  }
}

async function readConfirmedCompletion(
  response: Response,
  journey: OnboardingJourneyState,
  bootcampState: BootcampState,
): Promise<{ journeyId?: string; completedAt: number }> {
  if (!response.ok) throw new Error('first real message sync failed');
  const serverThread = (await response.json()) as {
    bootcampState?: { journeyId?: string; completedAt?: number };
  };
  const serverState = serverThread.bootcampState;
  if (!canCommitFirstRealMessage(journey, bootcampState, serverState)) {
    throw new Error('first real message sync was not confirmed');
  }
  if (serverState?.completedAt === undefined) {
    throw new Error('first real message completion was not returned');
  }
  return { journeyId: serverState.journeyId, completedAt: serverState.completedAt };
}

export function useFirstRealMessageSync({
  threadId,
  currentBootcampState,
  onboardingSyncError,
  setOnboardingSyncError,
  setShowOnboardingHint,
}: UseFirstRealMessageSyncOptions): {
  handleRealOnboardingMessage: (messageThreadId?: string) => void;
  requestRetry: () => void;
} {
  const [firstRealMessageRetryNonce, setFirstRealMessageRetryNonce] = useState(0);
  const pendingFirstRealMessageThreadRef = useRef<string | null>(null);
  const firstRealMessagePatchInFlightRef = useRef(false);

  const commitCompletedJourney = useCallback(
    (journey: OnboardingJourneyState, bootcampState: BootcampState, completedAt: number) => {
      const completed = markFirstRealMessage(journey, completedAt);
      localStorage.setItem(JOURNEY_STORAGE_KEY, JSON.stringify(completed));
      clearPendingMarker();
      pendingFirstRealMessageThreadRef.current = null;
      setOnboardingSyncError(false);
      setShowOnboardingHint(false);
      syncLocalBootcampState(threadId, { ...bootcampState, completedAt } as Thread['bootcampState']);
    },
    [setOnboardingSyncError, setShowOnboardingHint, threadId],
  );

  const retryAfterFailure = useCallback(() => {
    setOnboardingSyncError(true);
    setFirstRealMessageRetryNonce((value) => value + 1);
  }, [setOnboardingSyncError]);

  const reconcileWithServer = useCallback(
    (journey: OnboardingJourneyState, bootcampState: BootcampState) => {
      if (firstRealMessagePatchInFlightRef.current) return;
      pendingFirstRealMessageThreadRef.current = threadId;
      persistPendingMarker(journey.journeyId, threadId);
      firstRealMessagePatchInFlightRef.current = true;
      const completed = markFirstRealMessage(journey);
      const nextBootcampState = { ...bootcampState, completedAt: completed.completedAt ?? Date.now() };
      void (async () => {
        try {
          const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bootcampState: nextBootcampState }),
          });
          const serverState = await readConfirmedCompletion(response, journey, bootcampState);
          commitCompletedJourney(journey, { ...bootcampState, ...serverState }, serverState.completedAt);
        } catch {
          retryAfterFailure();
        } finally {
          firstRealMessagePatchInFlightRef.current = false;
        }
      })();
    },
    [commitCompletedJourney, retryAfterFailure, threadId],
  );

  const handleSyncContext = useCallback(
    ({ journey, bootcampState, action }: FirstRealMessageSyncContext) => {
      if (action === 'wait-for-hydration') {
        pendingFirstRealMessageThreadRef.current = threadId;
        persistPendingMarker(journey.journeyId, threadId);
        return;
      }
      if (action === 'ignore') {
        pendingFirstRealMessageThreadRef.current = null;
        clearPendingMarker();
        return;
      }
      if (action === 'already-complete' && bootcampState) {
        commitCompletedJourney(journey, bootcampState, bootcampState.completedAt ?? Date.now());
        return;
      }
      if (bootcampState) reconcileWithServer(journey, bootcampState);
    },
    [commitCompletedJourney, reconcileWithServer, threadId],
  );

  const handleRealOnboardingMessage = useCallback(
    (messageThreadId?: string) => {
      if (messageThreadId && messageThreadId !== threadId) return;
      const context = readSyncContext(threadId);
      if (context) handleSyncContext(context);
    },
    [handleSyncContext, threadId],
  );

  useEffect(() => {
    if (pendingFirstRealMessageThreadRef.current !== threadId || !currentBootcampState) return;
    handleRealOnboardingMessage(threadId);
  }, [currentBootcampState, handleRealOnboardingMessage, threadId]);

  useEffect(() => {
    try {
      const journey = restoreJourneyState(localStorage.getItem(JOURNEY_STORAGE_KEY));
      const pending = restoreFirstRealMessagePendingMarker(localStorage.getItem(PENDING_STORAGE_KEY));
      if (journey?.stage === 'ready' && pending?.threadId === threadId && pending.journeyId === journey.journeyId) {
        pendingFirstRealMessageThreadRef.current = threadId;
        if (currentBootcampState) {
          setOnboardingSyncError(true);
          setFirstRealMessageRetryNonce((value) => value + 1);
        }
      }
    } catch {
      // localStorage may be unavailable
    }
  }, [currentBootcampState, setOnboardingSyncError, threadId]);

  const retryFirstRealMessage = useCallback(
    () => handleRealOnboardingMessage(threadId),
    [handleRealOnboardingMessage, threadId],
  );
  useFirstRealMessageRetry({
    enabled: Boolean(
      onboardingSyncError && currentBootcampState && pendingFirstRealMessageThreadRef.current === threadId,
    ),
    retryKey: firstRealMessageRetryNonce,
    onRetry: retryFirstRealMessage,
  });

  const requestRetry = useCallback(() => {
    setFirstRealMessageRetryNonce((value) => value + 1);
  }, []);

  return { handleRealOnboardingMessage, requestRetry };
}
