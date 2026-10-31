import { type MutableRefObject, useMemo } from 'react';
import { apiFetch } from '@/utils/api-client';
import { invalidateSidebarProjection } from '@/utils/sidebar-thread-snapshot';
import type { FirstMessageAdmissionPhase, PendingNewConversationIntent } from './first-message-admission';
import { clearNewConversationIntent } from './new-conversation-intent-store';
import { createSessionImportAdmissionController } from './session-import-admission';
export function useNewConversationImport({
  intentRef,
  ownerRef,
  persistIntent,
  createThread,
  onNavigate,
  enqueue,
  setPhase,
  resetIntent,
}: {
  intentRef: MutableRefObject<PendingNewConversationIntent | null>;
  ownerRef: MutableRefObject<string | null>;
  persistIntent: (intent: PendingNewConversationIntent) => Promise<void>;
  createThread: (intent: PendingNewConversationIntent) => Promise<{ id: string }>;
  onNavigate: (id: string) => void;
  enqueue: (operation: () => Promise<void>) => Promise<void>;
  setPhase: (phase: FirstMessageAdmissionPhase) => void;
  resetIntent: () => Promise<void>;
}) {
  const importController = useMemo(
    () =>
      createSessionImportAdmissionController({
        readIntent: () => {
          if (!intentRef.current) throw new Error('intent unavailable');
          return intentRef.current;
        },
        persistIntent,
        createThread,
        resetIntent,
        navigate: onNavigate,
        onPhaseChange: setPhase,
        bind: async (threadId, selection) => {
          const response = await apiFetch(`/api/threads/${threadId}/sessions/${selection.catId}/bind`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cliSessionId: selection.sessionId, externalImport: true }),
          });
          if (!response.ok) throw Object.assign(new Error('Session binding failed'), await response.json());
        },
        complete: async () => {
          const owner = ownerRef.current;
          if (!owner) throw new Error('owner unavailable');
          await enqueue(() => clearNewConversationIntent(owner));
          await invalidateSidebarProjection();
        },
      }),
    [persistIntent, createThread, onNavigate, enqueue, intentRef, ownerRef, setPhase, resetIntent],
  );

  return importController;
}
