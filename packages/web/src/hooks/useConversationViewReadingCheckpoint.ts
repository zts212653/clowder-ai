'use client';

import type { ConversationViewPreference } from '@cat-cafe/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { projectSingleCatConversation } from '@/components/thread-chat/single-cat-conversation-projection';
import type { ChatReadingPort } from '@/components/thread-chat/useThreadChatReadingPort';
import type { ChatMessage, QueueEntry } from '@/stores/chat-types';
import {
  type ChatReadingRef,
  readChatReadingRef,
  releaseChatReadingRef,
  saveChatScrollState,
} from '@/utils/chat-scroll-memory';
import type { ConversationViewPreferenceController } from './useConversationViewPreference';

export function projectedConversationViewKey(
  view: ConversationViewPreference,
  messages: readonly ChatMessage[],
  queue: readonly QueueEntry[],
): string {
  if (view.mode !== 'cat') return 'group';
  return projectSingleCatConversation({ messages, queue, catId: view.catId }).hasEvidence
    ? `cat:${view.catId}`
    : 'group';
}

function retireCheckpointOnThreadExit(
  checkpoint: { ref: ChatReadingRef; port: ChatReadingPort },
  threadId: string,
): void {
  const snapshot = readChatReadingRef(checkpoint.ref);
  if (checkpoint.port.threadId !== threadId || snapshot?.threadId !== threadId) return;
  saveChatScrollState(threadId, snapshot.position);
  releaseChatReadingRef(checkpoint.ref, threadId);
}

/** Keeps the immutable group reading anchor while a single-cat projection owns the same viewport. */
export function useConversationViewReadingCheckpoint(input: {
  threadId: string;
  controller: ConversationViewPreferenceController;
  messages: readonly ChatMessage[];
  queue: readonly QueueEntry[];
}) {
  const { threadId, controller, messages, queue } = input;
  const readingPortRef = useRef<ChatReadingPort | null>(null);
  const groupCheckpointRef = useRef<{ ref: ChatReadingRef; port: ChatReadingPort } | null>(null);
  const visibleViewKey = useMemo(
    () => (controller.loading ? 'group' : projectedConversationViewKey(controller.snapshot.effective, messages, queue)),
    [controller.loading, controller.snapshot.effective, messages, queue],
  );
  const previousVisibleViewKeyRef = useRef('group');
  const setReadingPort = useCallback((port: ChatReadingPort | null) => {
    readingPortRef.current = port;
  }, []);

  useLayoutEffect(() => {
    previousVisibleViewKeyRef.current = 'group';
    return () => {
      const checkpoint = groupCheckpointRef.current;
      if (checkpoint) retireCheckpointOnThreadExit(checkpoint, threadId);
      groupCheckpointRef.current = null;
    };
  }, [threadId]);

  useLayoutEffect(
    () =>
      controller.subscribeBeforeCommit((previous, next) => {
        const previousKey = projectedConversationViewKey(previous.effective, messages, queue);
        if (previousKey === 'group' && next.effective.mode === 'group') {
          const unused = groupCheckpointRef.current;
          if (unused) unused.port.releaseReadingRef(unused.ref);
          groupCheckpointRef.current = null;
          return;
        }
        if (previousKey !== 'group' || next.effective.mode !== 'cat') return;
        const port = readingPortRef.current;
        const captured = port?.captureReadingRef();
        if (!port || !captured) return;
        const old = groupCheckpointRef.current;
        if (old) old.port.releaseReadingRef(old.ref);
        groupCheckpointRef.current = { ref: captured.ref, port };
      }),
    [controller.subscribeBeforeCommit, messages, queue],
  );

  useEffect(() => {
    const previousKey = previousVisibleViewKeyRef.current;
    previousVisibleViewKeyRef.current = visibleViewKey;
    if (!previousKey.startsWith('cat:') || visibleViewKey !== 'group') return;
    const checkpoint = groupCheckpointRef.current;
    if (!checkpoint) return;
    const abort = new AbortController();
    void checkpoint.port.restoreReadingRef(checkpoint.ref, abort.signal).then((receipt) => {
      if (receipt.status !== 'settled' || groupCheckpointRef.current !== checkpoint) return;
      checkpoint.port.releaseReadingRef(checkpoint.ref);
      groupCheckpointRef.current = null;
    });
    return () => abort.abort();
  }, [visibleViewKey]);

  return { setReadingPort, visibleViewKey };
}
