import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ChatMessage, QueueEntry } from '@/stores/chat-types';
import {
  findSendAttempt,
  observeQueuedSendAttempts,
  putSendAttempt,
  recoverSendAttempts,
  retireSendAttempt,
  useSendAttemptStore,
} from '@/stores/send-attempt-store';
import { useToastStore } from '@/stores/toastStore';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import { loadSendAttempts } from '@/utils/send-attempt-db';

export function useSendAttempts(threadId: string, messages: readonly ChatMessage[], queue: readonly QueueEntry[]) {
  const identity = useSyncExternalStore(
    apiSessionIdentity.subscribe,
    apiSessionIdentity.getSnapshot,
    apiSessionIdentity.getSnapshot,
  );
  const all = useSendAttemptStore((state) => state.attempts);
  const attempts = useMemo(
    () =>
      all.filter((attempt) => attempt.ownerUserId === (identity.ownerUserId ?? '') && attempt.threadId === threadId),
    [all, identity.ownerUserId, threadId],
  );
  useEffect(() => {
    if (!identity.ownerUserId) return;
    let stale = false;
    void loadSendAttempts(identity.ownerUserId, threadId)
      .then((loaded) => {
        if (stale || apiSessionIdentity.getSnapshot().ownerUserId !== identity.ownerUserId) return;
        loaded.forEach((attempt) => {
          if (!findSendAttempt(attempt.ownerUserId, threadId, attempt.id))
            putSendAttempt({ ...attempt, previewUrls: attempt.files.map((file) => URL.createObjectURL(file)) });
        });
        recoverSendAttempts(threadId);
      })
      .catch(() => {
        if (!stale)
          useToastStore.getState().addToast({
            type: 'error',
            title: '未能恢复本地发送记录',
            message: '请重新打开这条会话再试。',
            duration: 6000,
          });
      });
    const recover = () => recoverSendAttempts(threadId);
    window.addEventListener('online', recover);
    return () => {
      stale = true;
      window.removeEventListener('online', recover);
    };
  }, [identity.ownerUserId, threadId]);
  useEffect(() => {
    observeQueuedSendAttempts(threadId, queue);
  }, [threadId, queue]);
  useEffect(() => {
    attempts.forEach((attempt) => {
      const canonical = messages.find(
        (message) =>
          !message.queuedEntryId && (message.clientMessageId === attempt.id || message.id === attempt.serverMessageId),
      );
      if (canonical && (canonical.deliveredAt || attempt.status === 'delivered'))
        void retireSendAttempt(attempt).catch(() => {});
    });
  }, [messages, attempts]);
  return attempts;
}
