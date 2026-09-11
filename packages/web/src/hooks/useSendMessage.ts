'use client';

import type { ContextAttachment, MessageWorkDisposition } from '@cat-cafe/shared';
import { useCallback, useState } from 'react';
import { useChatCommands } from '@/hooks/useChatCommands';
import { type ChatMessage as ChatMessageData, useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

export type UploadStatus = 'idle' | 'uploading' | 'failed';

export interface WhisperOptions {
  visibility: 'whisper';
  whisperTo: string[];
}

export interface PostAdmissionTargetAction {
  targetId: string;
  strategy: 'guide_reply' | 'interrupt_reply';
}

export interface PostAdmissionAction {
  kind: 'steer';
  targets: readonly PostAdmissionTargetAction[];
}

interface MessageAdmissionResponse {
  status?: string;
  entryId?: string;
  entries?: Array<{ entryId: string; targetCatId: string }>;
  gameThreadId?: string;
}

async function applyOnePostAdmissionAction(
  threadId: string,
  entryId: string | undefined,
  target: PostAdmissionTargetAction,
): Promise<string | null> {
  if (!entryId) return `${target.targetId}: 缺少精确队列工单`;
  try {
    const route = target.strategy === 'guide_reply' ? 'continue' : 'steer';
    const response = await apiFetch(`/api/threads/${threadId}/queue/${entryId}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetCatId: target.targetId }),
    });
    if (response.ok || response.status === 404) return null;
    const body = await response.json().catch(() => null);
    // Admission already committed and immediately requested Queue drain. If
    // that drain won, the user's immediate-send outcome is converging rather
    // than failing and must not create a second system error bubble.
    if (body?.code === 'ENTRY_PROCESSING' || body?.code === 'ENTRY_NOT_FOUND') return null;
    return `${target.targetId}: ${body?.error ?? `Server error: ${response.status}`}`;
  } catch (error) {
    return `${target.targetId}: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

/**
 * Submit one durable Queue input. History and active-invocation UI are projected
 * exclusively from lifecycle events after server admission; this hook never creates
 * an optimistic History bubble or a client-owned invocation.
 */
export function useSendMessage(activeThreadId?: string) {
  const addMessageToThread = useChatStore((state) => state.addMessageToThread);
  const { processCommand } = useChatCommands();
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
  const [uploadError, setUploadError] = useState<string | null>(null);

  const createClientId = useCallback((): string => {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();

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

  const publishError = useCallback(
    (threadId: string, content: string) => {
      const message: ChatMessageData = {
        id: `err-${Date.now()}`,
        type: 'system',
        variant: 'error',
        content,
        timestamp: Date.now(),
      };
      addMessageToThread(threadId, message);
    },
    [addMessageToThread],
  );

  const applyPostAdmissionActions = useCallback(
    async (
      threadId: string,
      entries: readonly { entryId: string; targetCatId: string }[],
      action: PostAdmissionAction,
    ): Promise<void> => {
      const entryByTarget = new Map(entries.map((entry) => [entry.targetCatId, entry.entryId]));
      const outcomes = await Promise.all(
        action.targets.map((target) =>
          applyOnePostAdmissionAction(threadId, entryByTarget.get(target.targetId), target),
        ),
      );
      const failures = outcomes.filter((outcome): outcome is string => outcome !== null);
      if (failures.length > 0) {
        publishError(threadId, `消息已进入队列，但部分 Steer 未执行：${failures.join('；')}`);
      }
    },
    [publishError],
  );

  const handleSend = useCallback(
    async (
      content: string,
      images?: File[],
      overrideThreadId?: string,
      whisper?: WhisperOptions,
      postAdmissionAction?: PostAdmissionAction,
      replyToId?: string,
      messageDisposition?: MessageWorkDisposition,
      contextAttachments?: ContextAttachment[],
      explicitTargetCats?: string[],
    ) => {
      const threadId = overrideThreadId ?? activeThreadId ?? useChatStore.getState().currentThreadId;
      const hasImages = Boolean(images?.length);
      setUploadError(null);
      setUploadStatus(hasImages ? 'uploading' : 'idle');

      const wasCommand = await processCommand(content, threadId);
      if (wasCommand) return false;

      const clientMessageId = createClientId();

      try {
        let response: Response;
        if (hasImages) {
          const formData = new FormData();
          formData.append('content', content);
          formData.append('threadId', threadId);
          formData.append('idempotencyKey', clientMessageId);
          if (messageDisposition) formData.append('messageDisposition', messageDisposition);
          for (const catId of explicitTargetCats ?? []) formData.append('mentions', catId);
          if (whisper) {
            formData.append('visibility', whisper.visibility);
            for (const catId of whisper.whisperTo) formData.append('whisperTo', catId);
          }
          if (replyToId) formData.append('replyTo', replyToId);
          if (contextAttachments?.length) {
            formData.append('contextAttachments', JSON.stringify(contextAttachments));
          }
          for (const image of images ?? []) formData.append('images', image);
          response = await apiFetch('/api/messages', { method: 'POST', body: formData });
        } else {
          response = await apiFetch('/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content,
              threadId,
              idempotencyKey: clientMessageId,
              ...(whisper ? { visibility: whisper.visibility, whisperTo: whisper.whisperTo } : {}),
              ...(replyToId ? { replyTo: replyToId } : {}),
              ...(messageDisposition ? { messageDisposition } : {}),
              ...(explicitTargetCats?.length ? { mentions: explicitTargetCats } : {}),
              ...(contextAttachments?.length ? { contextAttachments } : {}),
            }),
          });
        }

        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.detail ?? body?.error ?? `Server error: ${response.status}`);
        }

        const admission = (await response.json().catch(() => null)) as MessageAdmissionResponse | null;
        if (admission?.status !== 'game_started' && admission?.status !== 'queued') {
          throw new Error('Server did not return a canonical Queue admission');
        }
        if (postAdmissionAction?.kind === 'steer') {
          const entries = admission.entries ?? [];
          if (entries.length === 0) throw new Error('Steer admission did not return its canonical Queue entry');
          await applyPostAdmissionActions(threadId, entries, postAdmissionAction);
        }

        setUploadStatus('idle');
        setUploadError(null);
        window.dispatchEvent(new CustomEvent('guide:confirm', { detail: { target: 'chat.input' } }));
        return true;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        if (hasImages) {
          setUploadStatus('failed');
          setUploadError(errorMessage);
        } else {
          setUploadStatus('idle');
        }
        publishError(threadId, `Failed to send message: ${errorMessage}`);
        return false;
      }
    },
    [activeThreadId, applyPostAdmissionActions, createClientId, processCommand, publishError],
  );

  return { handleSend, uploadStatus, uploadError };
}
