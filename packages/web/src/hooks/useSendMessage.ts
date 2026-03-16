'use client';

import { useCallback, useState } from 'react';
import { useAgentMessages } from '@/hooks/useAgentMessages';
import { useChatCommands } from '@/hooks/useChatCommands';
import type { DeliveryMode } from '@/stores/chat-types';
import { type ChatMessage as ChatMessageData, useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

export type UploadStatus = 'idle' | 'uploading' | 'failed';

/** F35: Whisper options for private messages */
export interface WhisperOptions {
  visibility: 'whisper';
  whisperTo: string[];
}

/**
 * Hook for sending messages (text + optional images + optional whisper).
 * Handles both JSON and multipart form data modes.
 */
export function useSendMessage(activeThreadId?: string) {
  const {
    addMessage,
    addMessageToThread,
    removeMessage,
    removeThreadMessage,
    replaceThreadMessageId,
    setLoading,
    setHasActiveInvocation,
    setThreadLoading,
    setThreadHasActiveInvocation,
  } = useChatStore();
  const { resetRefs } = useAgentMessages();
  const { processCommand } = useChatCommands();
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
  const [uploadError, setUploadError] = useState<string | null>(null);

  const createClientId = useCallback((): string => {
    if (globalThis.crypto?.randomUUID) {
      return globalThis.crypto.randomUUID();
    }

    const randomHex = (length: number) =>
      Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');

    return [
      randomHex(8),
      randomHex(4),
      `4${randomHex(3)}`,
      `${['8', '9', 'a', 'b'][Math.floor(Math.random() * 4)]}${randomHex(3)}`,
      randomHex(12),
    ].join('-');
  }, []);

  const handleSend = useCallback(
    async (
      content: string,
      images?: File[],
      overrideThreadId?: string,
      whisper?: WhisperOptions,
      deliveryMode?: DeliveryMode,
    ) => {
      const activeThread = activeThreadId ?? useChatStore.getState().currentThreadId;
      const threadId = overrideThreadId ?? activeThread;
      const hasImages = Boolean(images && images.length > 0);
      const isQueueSend = deliveryMode === 'queue';

      // Queue sends don't reset refs — cat is still streaming
      if (!isQueueSend) resetRefs();
      setUploadError(null);
      setUploadStatus(hasImages ? 'uploading' : 'idle');

      const wasCommand = await processCommand(content, threadId);
      if (wasCommand) return;

      const clientMessageId = createClientId();
      const optimisticMessageId = `user-${clientMessageId}`;

      // Create user message
      const userMsg: ChatMessageData = {
        id: optimisticMessageId,
        type: 'user',
        content,
        timestamp: Date.now(),
        ...(whisper ? { visibility: whisper.visibility, whisperTo: whisper.whisperTo } : {}),
      };
      if (images && images.length > 0) {
        userMsg.contentBlocks = [
          { type: 'text' as const, text: content },
          ...images.map((img) => ({
            type: 'image' as const,
            url: URL.createObjectURL(img),
          })),
        ];
      }
      // F117: Queue sends skip optimistic insert — bubble appears only on messages_delivered
      // (prevents queued message from showing in chat timeline before delivery)
      if (!isQueueSend) {
        if (threadId !== activeThread) {
          addMessageToThread(threadId, userMsg);
        } else {
          addMessage(userMsg);
        }
      }

      // F39: Queue sends don't flip loading/invocation flags — cat is already running,
      // and queue_updated WS event will surface the entry in QueuePanel.
      if (!isQueueSend) {
        if (threadId !== activeThread) {
          setThreadLoading(threadId, true);
          setThreadHasActiveInvocation(threadId, true);
        } else {
          setLoading(true);
          setHasActiveInvocation(true);
        }
      }

      const reconcileQueuedResponse = (
        body: { status?: string; userMessageId?: string; gameThreadId?: string } | null,
      ) => {
        // Game started in independent thread — remove optimistic message from source
        // and clear loading/invocation flags (game runs in its own thread, source is idle).
        // Always use thread-scoped APIs here: by the time the HTTP response arrives,
        // the user may have navigated to the game thread (via game:thread_created),
        // so the source thread may no longer be active. Thread-scoped APIs check
        // currentThreadId at call-time, correctly targeting flat or background state.
        if (body?.status === 'game_started' && body.gameThreadId) {
          removeThreadMessage(threadId, optimisticMessageId);
          setThreadLoading(threadId, false);
          setThreadHasActiveInvocation(threadId, false);
          return true;
        }
        if (body?.status !== 'queued' || isQueueSend) return false;
        if (threadId !== activeThread) {
          removeThreadMessage(threadId, optimisticMessageId);
        } else {
          removeMessage(optimisticMessageId);
        }
        return true;
      };

      try {
        const deliveryModePayload = deliveryMode ? { deliveryMode } : {};

        if (images && images.length > 0) {
          const formData = new FormData();
          formData.append('content', content);
          formData.append('threadId', threadId);
          formData.append('idempotencyKey', clientMessageId);
          if (deliveryMode) formData.append('deliveryMode', deliveryMode);
          if (whisper) {
            formData.append('visibility', whisper.visibility);
            for (const catId of whisper.whisperTo) {
              formData.append('whisperTo', catId);
            }
          }
          for (const img of images) {
            formData.append('images', img);
          }
          const res = await apiFetch('/api/messages', {
            method: 'POST',
            body: formData,
          });
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw new Error(body?.detail ?? `Server error: ${res.status}`);
          }
          const body = await res.json().catch(() => null);
          if (!reconcileQueuedResponse(body) && body?.userMessageId) {
            replaceThreadMessageId(threadId, optimisticMessageId, body.userMessageId);
          }
        } else {
          const res = await apiFetch('/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content,
              threadId,
              idempotencyKey: clientMessageId,
              ...(whisper ? { visibility: whisper.visibility, whisperTo: whisper.whisperTo } : {}),
              ...deliveryModePayload,
            }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw new Error(body?.detail ?? `Server error: ${res.status}`);
          }
          const body = await res.json().catch(() => null);
          if (!reconcileQueuedResponse(body) && body?.userMessageId) {
            replaceThreadMessageId(threadId, optimisticMessageId, body.userMessageId);
          }
        }
        setUploadStatus('idle');
        setUploadError(null);
      } catch (err) {
        // F39: Only clear invocation flags for normal (non-queue, non-force) sends.
        // Queue sends never set them. Force sends target a thread where a cat is
        // already running — if the force request fails (network/server error), the
        // original invocation is still active; clearing flags would hide stop/queue UI.
        const shouldClearFlags = !isQueueSend && deliveryMode !== 'force';
        if (shouldClearFlags) {
          setThreadLoading(threadId, false);
          setThreadHasActiveInvocation(threadId, false);
        }
        const errorMessage = err instanceof Error ? err.message : 'Unknown';
        if (hasImages) {
          setUploadStatus('failed');
          setUploadError(errorMessage);
        } else {
          setUploadStatus('idle');
        }
        const errorMessagePayload: ChatMessageData = {
          id: `err-${Date.now()}`,
          type: 'system',
          variant: 'error',
          content: `Failed to send message: ${errorMessage}`,
          timestamp: Date.now(),
        };
        if (threadId !== activeThread) {
          addMessageToThread(threadId, errorMessagePayload);
        } else {
          addMessage(errorMessagePayload);
        }
      }
    },
    [
      resetRefs,
      processCommand,
      addMessage,
      addMessageToThread,
      removeMessage,
      removeThreadMessage,
      replaceThreadMessageId,
      setLoading,
      setHasActiveInvocation,
      setThreadLoading,
      setThreadHasActiveInvocation,
      activeThreadId,
      createClientId,
    ],
  );

  return { handleSend, uploadStatus, uploadError };
}
