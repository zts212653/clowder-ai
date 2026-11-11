import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { SocketCallbacks } from '@/hooks/useSocket';
import { type Thread, useChatStore } from '@/stores/chatStore';
import { type TaskItem, useTaskStore } from '@/stores/taskStore';
import { invalidateSidebarProjection } from '@/utils/sidebar-thread-snapshot';

interface ExternalDeps {
  threadId: string;
  handleAgentMessage: SocketCallbacks['onMessage'];
  onIndexEvent?: SocketCallbacks['onIndexEvent'];
  sourceNeeded?: (source: string, threadId?: string) => boolean;
}

/**
 * Socket event callbacks for a chat thread.
 * Extracted from ChatContainer to reduce file size.
 */
export function useChatSocketCallbacks({
  threadId,
  handleAgentMessage,
  onIndexEvent,
  sourceNeeded = () => true,
}: ExternalDeps): SocketCallbacks {
  const {
    updateThreadTitle,
    updateThreadParticipants,
    setLoading,
    setHasActiveInvocation,
    setIntentMode,
    setTargetCats,
    removeThreadMessage,
    requestStreamCatchUp,
  } = useChatStore(
    useShallow((s) => ({
      updateThreadTitle: s.updateThreadTitle,
      updateThreadParticipants: s.updateThreadParticipants,
      setLoading: s.setLoading,
      setHasActiveInvocation: s.setHasActiveInvocation,
      setIntentMode: s.setIntentMode,
      setTargetCats: s.setTargetCats,
      removeThreadMessage: s.removeThreadMessage,
      requestStreamCatchUp: s.requestStreamCatchUp,
    })),
  );
  const { addTask, updateTask } = useTaskStore(
    useShallow((state) => ({ addTask: state.addTask, updateTask: state.updateTask })),
  );

  return useMemo<SocketCallbacks>(
    () => ({
      onMessage: (msg) => {
        handleAgentMessage(msg);
        return true;
      },
      onThreadUpdated: (data) => {
        if (data.title !== undefined) updateThreadTitle(data.threadId, data.title);
        if (data.participants !== undefined) updateThreadParticipants(data.threadId, data.participants);
        if (data.bootcampState !== undefined) {
          useChatStore.setState((state) => ({
            threads: state.threads.map((t) =>
              t.id === data.threadId ? { ...t, bootcampState: data.bootcampState as Thread['bootcampState'] } : t,
            ),
          }));
        }
      },
      onIntentMode: (data) => {
        // Socket layer (useSocket) already applies dual-pointer guard + background routing.
        // This callback only fires for the truly active thread.
        setLoading(true);
        setHasActiveInvocation(true);
        setIntentMode(data.mode as 'ideate' | 'execute');
        setTargetCats((data as { targetCats?: string[] }).targetCats ?? []);
      },
      onSpawnStarted: (data) => {
        // F118 D2: Earliest signal — fires before intent_mode.
        // Per-cat setCatStatus('spawning') is handled by the socket layer.
        setLoading(true);
        setHasActiveInvocation(true);
        setTargetCats(data.targetCats ?? []);
      },
      onTaskCreated: (task) => {
        const t = task as Record<string, unknown>;
        if (
          !sourceNeeded('project.workbench.tasks', String(t.threadId)) ||
          t.threadId !== threadId ||
          t.kind === 'pr_tracking'
        )
          return;
        addTask(task as unknown as TaskItem);
      },
      onTaskUpdated: (task) => {
        const t = task as Record<string, unknown>;
        if (
          !sourceNeeded('project.workbench.tasks', String(t.threadId)) ||
          t.threadId !== threadId ||
          t.kind === 'pr_tracking'
        )
          return;
        updateTask(task as unknown as TaskItem);
      },
      // onThreadSummary removed (clowder-ai#343): summaries no longer injected into chat flow.
      onMessageDeleted: (data: { messageId: string; threadId: string }) =>
        sourceNeeded('chat.messages', data.threadId) && removeThreadMessage(data.threadId, data.messageId),
      onMessageRestored: (data: { messageId: string; threadId: string }) => {
        if (sourceNeeded('chat.messages', data.threadId)) requestStreamCatchUp(data.threadId);
      },
      onMessageRecalled: (data) => {
        if (!sourceNeeded('chat.messages', data.threadId)) return;
        if (data.verdict === 'zero_exposure') {
          removeThreadMessage(data.threadId, data.messageId);
          return;
        }
        if (sourceNeeded('chat.messages', data.threadId)) requestStreamCatchUp(data.threadId);
      },
      onMessageReceiptUpdated: (data) => {
        if (sourceNeeded('chat.messages', data.threadId)) requestStreamCatchUp(data.threadId);
      },
      onCustodyOfferUpdated: (data) => {
        if (sourceNeeded('chat.messages', data.threadId)) requestStreamCatchUp(data.threadId);
      },
      onThreadBranched: () => {
        void invalidateSidebarProjection();
      },
      onIndexEvent,
    }),
    [
      handleAgentMessage,
      updateThreadTitle,
      updateThreadParticipants,
      setLoading,
      setHasActiveInvocation,
      setIntentMode,
      setTargetCats,
      addTask,
      updateTask,
      removeThreadMessage,
      requestStreamCatchUp,
      onIndexEvent,
      sourceNeeded,
      threadId,
    ],
  );
}
