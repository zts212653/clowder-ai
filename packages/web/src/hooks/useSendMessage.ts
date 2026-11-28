'use client';

import type { ContextAttachment, MessageWorkDisposition } from '@cat-cafe/shared';
import { routingConfirmationRequiredSchema } from '@cat-cafe/shared/routing-preview';
import { useCallback, useState } from 'react';
import { useChatCommands } from '@/hooks/useChatCommands';
import { type ChatMessage as ChatMessageData, useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { reconcileThreadWithServer } from './queue-reconciliation';
import { sendErrorNoticeId, settleSendErrorNotice } from './send-error-notice';

export type UploadStatus = 'idle' | 'uploading' | 'failed';

export interface WhisperOptions {
  visibility: 'whisper';
  whisperTo: string[];
}

export interface SendMessageAdmissionOptions {
  /** A recoverable first-message owner supplies the same key on every retry. */
  idempotencyKey?: string;
  messageDisposition?: MessageWorkDisposition;
  composerDraftRevision?: number | 'current';
  composerDraftConsumed?: (revision: number) => void;
  signal?: AbortSignal;
}

interface MessageAdmissionResponse {
  status?: string;
  gameThreadId?: string;
  composerDraftConsumption?: { threadId: string; revision: number };
}

/**
 * Submit one durable Queue input. History and active-invocation UI are projected
 * exclusively from lifecycle events after server admission; this hook never creates
 * an optimistic History bubble or a client-owned invocation.
 */
export type RoutingConfirmation = (
  request: ReturnType<typeof routingConfirmationRequiredSchema.parse>,
) => Promise<boolean>;

export function useSendMessage(activeThreadId?: string, confirm?: RoutingConfirmation) {
  const addMessageToThread = useChatStore((state) => state.addMessageToThread);
  const patchThreadMessage = useChatStore((state) => state.patchThreadMessage);
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
    (threadId: string, attemptId: string, content: string) => {
      const id = sendErrorNoticeId(attemptId);
      const message: ChatMessageData = {
        id,
        type: 'system',
        variant: 'error',
        content,
        timestamp: Date.now(),
      };
      // The notice belongs to the attempt that failed: a second failure of the
      // same attempt rewrites it in place instead of stacking another bubble
      // (`addMessageToThread` ignores an id it already holds).
      patchThreadMessage(threadId, id, { content: message.content, timestamp: message.timestamp });
      addMessageToThread(threadId, message);
    },
    [addMessageToThread, patchThreadMessage],
  );

  const settleSendError = useCallback((threadId: string, attemptId: string) => {
    // Same rule the live projections use (Queue admission, delivery), so a late
    // commit settles through whichever proof arrives first.
    settleSendErrorNotice(threadId, attemptId);
  }, []);

  const handleSend = useCallback(
    async (
      content: string,
      images?: File[],
      overrideThreadId?: string,
      whisper?: WhisperOptions,
      replyToId?: string,
      contextAttachments?: ContextAttachment[],
      explicitTargetCats?: string[],
      admissionOptions?: SendMessageAdmissionOptions,
    ) => {
      const threadId = overrideThreadId ?? activeThreadId ?? useChatStore.getState().currentThreadId;
      const hasImages = Boolean(images?.length);
      const { composerDraftRevision, composerDraftConsumed, signal } = admissionOptions ?? {};
      if (signal?.aborted) return false;
      setUploadError(null);
      setUploadStatus(hasImages ? 'uploading' : 'idle');

      const wasCommand = await processCommand(content, threadId);
      if (wasCommand) return false;

      const clientMessageId = admissionOptions?.idempotencyKey ?? createClientId();

      try {
        const submit = (confirmedTargetCats?: string[]) => {
          if (hasImages) {
            const formData = new FormData();
            formData.append('content', content);
            formData.append('threadId', threadId);
            formData.append('idempotencyKey', clientMessageId);
            if (composerDraftRevision !== undefined)
              formData.append('composerDraftRevision', String(composerDraftRevision));
            if (admissionOptions?.messageDisposition) {
              formData.append('messageDisposition', admissionOptions.messageDisposition);
            }
            for (const catId of explicitTargetCats ?? []) formData.append('mentions', catId);
            for (const catId of confirmedTargetCats ?? []) formData.append('confirmedTargetCats', catId);
            if (whisper) {
              formData.append('visibility', whisper.visibility);
              for (const catId of whisper.whisperTo) formData.append('whisperTo', catId);
            }
            if (replyToId) formData.append('replyTo', replyToId);
            if (contextAttachments?.length) {
              formData.append('contextAttachments', JSON.stringify(contextAttachments));
            }
            for (const image of images ?? []) formData.append('images', image);
            return apiFetch('/api/messages', { method: 'POST', body: formData, ...(signal ? { signal } : {}) });
          } else {
            return apiFetch('/api/messages', {
              method: 'POST',
              ...(signal ? { signal } : {}),
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                content,
                threadId,
                idempotencyKey: clientMessageId,
                ...(composerDraftRevision === undefined ? {} : { composerDraftRevision }),
                ...(admissionOptions?.messageDisposition
                  ? { messageDisposition: admissionOptions.messageDisposition }
                  : {}),
                ...(whisper ? { visibility: whisper.visibility, whisperTo: whisper.whisperTo } : {}),
                ...(replyToId ? { replyTo: replyToId } : {}),
                ...(explicitTargetCats?.length ? { mentions: explicitTargetCats } : {}),
                ...(confirmedTargetCats ? { confirmedTargetCats } : {}),
                ...(contextAttachments?.length ? { contextAttachments } : {}),
              }),
            });
          }
        };
        let response = await submit();
        if (response.status === 409) {
          const payload: unknown = await response
            .clone()
            .json()
            .catch(() => null);
          const redirect = routingConfirmationRequiredSchema.safeParse(payload);
          if (redirect.success) {
            if (!confirm) throw new Error('需要在聊天页面确认实际接收者后才能改发。');
            const accepted = await confirm(redirect.data);
            if (!accepted) {
              setUploadStatus('idle');
              return false;
            }
            response = await submit(redirect.data.targets.map((member) => member.catId));
          }
        }

        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.detail ?? body?.error ?? `Server error: ${response.status}`);
        }

        const admission = (await response.json().catch(() => null)) as MessageAdmissionResponse | null;
        if (admission?.status !== 'game_started' && admission?.status !== 'queued') {
          throw new Error('Server did not return a canonical Queue admission');
        }
        const consumed = admission.composerDraftConsumption;
        if (consumed?.threadId === threadId && Number.isSafeInteger(consumed.revision)) {
          composerDraftConsumed?.(consumed.revision);
        }
        // A successful send must remain visible even if its Queue socket event was
        // missed. Reuse the same fenced server snapshot as reconnect, not a local bubble.
        if (admission.status === 'queued') void reconcileThreadWithServer(threadId, () => false, 'SendAdmission');
        // Admission proves the server holds this attempt, including a late commit
        // whose client had already timed out. Any notice from an earlier try of
        // this same attempt is now out of date.
        settleSendError(threadId, clientMessageId);
        setUploadStatus('idle');
        setUploadError(null);
        window.dispatchEvent(new CustomEvent('guide:confirm', { detail: { target: 'chat.input' } }));
        return true;
      } catch (error) {
        if (signal?.aborted) {
          setUploadStatus('idle');
          return false;
        }
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        if (hasImages) {
          setUploadStatus('failed');
          setUploadError(errorMessage);
        } else {
          setUploadStatus('idle');
        }
        publishError(threadId, clientMessageId, `Failed to send message: ${errorMessage}`);
        return false;
      }
    },
    [activeThreadId, confirm, createClientId, processCommand, publishError, settleSendError],
  );

  return { handleSend, uploadStatus, uploadError };
}
