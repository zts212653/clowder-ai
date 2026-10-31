import { useEffect, useId, useMemo } from 'react';
import type { useChatHistory } from '@/hooks/useChatHistory';
import { useChatStore } from '@/stores/chatStore';

export type ChatReadingOperations = Pick<
  ReturnType<typeof useChatHistory>,
  'captureReadingRef' | 'restoreReadingRef' | 'releaseReadingRef' | 'navigateToMessage'
>;

export type ChatReadingPort = ChatReadingOperations & { readonly threadId: string; readonly ownerId: string };
export type RegisterChatReadingPort = (port: ChatReadingPort) => () => void;

export function useThreadChatReadingPort(
  threadId: string,
  presentation: 'conversation' | 'composer-only',
  register: RegisterChatReadingPort | undefined,
  history: ChatReadingOperations,
): void {
  const { captureReadingRef, restoreReadingRef, releaseReadingRef, navigateToMessage } = history;
  const ownerId = useId();
  const currentThreadId = useChatStore((state) => state.currentThreadId);
  const port = useMemo(
    () => ({ threadId, ownerId, captureReadingRef, restoreReadingRef, releaseReadingRef, navigateToMessage }),
    [threadId, ownerId, captureReadingRef, restoreReadingRef, releaseReadingRef, navigateToMessage],
  );
  useEffect(() => {
    if (presentation !== 'conversation' || !register || currentThreadId !== threadId) return;
    return register(port);
  }, [presentation, register, port, currentThreadId, threadId]);
}
