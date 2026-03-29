import type { GameView } from '@cat-cafe/shared';
import { useMemo } from 'react';
import type { SocketCallbacks } from '@/hooks/useSocket';
import { type ChatMessage as ChatMessageData, useChatStore } from '@/stores/chatStore';
import { useGameStore } from '@/stores/gameStore';
import { type TaskItem, useTaskStore } from '@/stores/taskStore';

interface ExternalDeps {
  threadId: string;
  userId: string;
  handleAgentMessage: SocketCallbacks['onMessage'];
  resetTimeout: () => void;
  clearDoneTimeout: (threadId?: string) => void;
  handleAuthRequest: NonNullable<SocketCallbacks['onAuthorizationRequest']>;
  handleAuthResponse: NonNullable<SocketCallbacks['onAuthorizationResponse']>;
  onNavigateToThread?: (threadId: string) => void;
}

/**
 * Socket event callbacks for a chat thread.
 * Extracted from ChatContainer to reduce file size.
 */
export function useChatSocketCallbacks({
  threadId,
  userId,
  handleAgentMessage,
  resetTimeout,
  clearDoneTimeout,
  handleAuthRequest,
  handleAuthResponse,
  onNavigateToThread,
}: ExternalDeps): SocketCallbacks {
  const {
    updateThreadTitle,
    updateThreadParticipants,
    setLoading,
    setHasActiveInvocation,
    setIntentMode,
    setTargetCats,
    addMessage,
    removeThreadMessage,
    requestStreamCatchUp,
  } = useChatStore();
  const { addTask, updateTask } = useTaskStore();

  return useMemo<SocketCallbacks>(
    () => ({
      clearDoneTimeout,
      onMessage: (msg) => {
        handleAgentMessage(msg);
        return true;
      },
      onThreadUpdated: (data) => {
        if (data.title !== undefined) updateThreadTitle(data.threadId, data.title);
        if (data.participants !== undefined) updateThreadParticipants(data.threadId, data.participants);
      },
      onIntentMode: (data) => {
        // Socket layer (useSocket) already applies dual-pointer guard + background routing.
        // This callback only fires for the truly active thread.
        setLoading(true);
        setHasActiveInvocation(true);
        setIntentMode(data.mode as 'ideate' | 'execute');
        setTargetCats((data as { targetCats?: string[] }).targetCats ?? []);
      },
      onTaskCreated: (task) => addTask(task as unknown as TaskItem),
      onTaskUpdated: (task) => updateTask(task as unknown as TaskItem),
      onThreadSummary: (summary) => {
        const s = summary as {
          id: string;
          threadId: string;
          topic: string;
          conclusions: string[];
          openQuestions: string[];
          createdBy: string;
          createdAt: number;
        };
        addMessage({
          id: `summary-${s.id}`,
          type: 'summary',
          content: s.topic,
          timestamp: s.createdAt,
          summary: {
            id: s.id,
            topic: s.topic,
            conclusions: s.conclusions,
            openQuestions: s.openQuestions,
            createdBy: s.createdBy,
          },
        } as ChatMessageData);
      },
      onHeartbeat: (data) => {
        if (data.threadId === threadId) resetTimeout();
      },
      onMessageDeleted: (data: { messageId: string; threadId: string }) =>
        removeThreadMessage(data.threadId, data.messageId),
      onMessageRestored: (data: { messageId: string; threadId: string }) => {
        requestStreamCatchUp(data.threadId);
      },
      onThreadBranched: () => {
        /* branch navigation handled by the action initiator */
      },
      onAuthorizationRequest: handleAuthRequest,
      onAuthorizationResponse: handleAuthResponse,
      onGameStateUpdate: (data) => {
        const view = data.view as GameView;
        // P1-3 fix: Only accept updates for the current thread
        if (view.threadId !== threadId) return;
        useGameStore.getState().setGameView(view, data.gameId, threadId);
      },
      onGameThreadCreated: (data) => {
        // Only navigate the initiator — other users in the room should not be auto-redirected
        if (data.initiatorUserId === userId) {
          onNavigateToThread?.(data.gameThreadId);
        }
      },
    }),
    [
      handleAgentMessage,
      updateThreadTitle,
      setLoading,
      setHasActiveInvocation,
      setIntentMode,
      setTargetCats,
      addTask,
      updateTask,
      addMessage,
      removeThreadMessage,
      requestStreamCatchUp,
      resetTimeout,
      clearDoneTimeout,
      handleAuthRequest,
      handleAuthResponse,
      onNavigateToThread,
      threadId,
      userId,
    ],
  );
}
