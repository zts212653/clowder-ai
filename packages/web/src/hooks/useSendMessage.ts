'use client';

import type { ContextAttachment, MessageWorkDisposition } from '@cat-cafe/shared';
import { useCallback, useState } from 'react';
import {
  acknowledgeSendComposerDraftConsumption,
  type ComposerDraftConsumption,
} from '@/components/composer-draft-consumption';
import { observeComposerDraft } from '@/components/composer-draft-flush-registry';
import { useChatCommands } from '@/hooks/useChatCommands';
import { type ChatMessage as ChatMessageData, useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { reconcileThreadWithServer } from './queue-reconciliation';

export type UploadStatus = 'idle' | 'uploading' | 'failed';

export interface WhisperOptions {
  visibility: 'whisper';
  whisperTo: string[];
}

export interface SendMessageAdmissionOptions {
  /** A recoverable first-message owner supplies the same key on every retry. */
  idempotencyKey?: string;
  /** Set by the ChatInput admission adapter; domain/interactive sends preserve the mounted draft. */
  consumeComposerDraft?: boolean;
  messageDisposition?: MessageWorkDisposition;
}

interface MessageAdmissionResponse {
  status?: string;
  gameThreadId?: string;
  composerDraftConsumption?: ComposerDraftConsumption;
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
      const composerDraftRevision = admissionOptions?.consumeComposerDraft
        ? observeComposerDraft(threadId)?.revision
        : undefined;
      const hasImages = Boolean(images?.length);
      setUploadError(null);
      setUploadStatus(hasImages ? 'uploading' : 'idle');

      const wasCommand = await processCommand(content, threadId);
      if (wasCommand) return false;

      const clientMessageId = admissionOptions?.idempotencyKey ?? createClientId();

      try {
        let response: Response;
        if (hasImages) {
          const formData = new FormData();
          formData.append('content', content);
          formData.append('threadId', threadId);
          formData.append('idempotencyKey', clientMessageId);
          if (admissionOptions?.messageDisposition) {
            formData.append('messageDisposition', admissionOptions.messageDisposition);
          }
          for (const catId of explicitTargetCats ?? []) formData.append('mentions', catId);
          if (composerDraftRevision !== undefined)
            formData.append('composerDraftRevision', String(composerDraftRevision));
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
              ...(admissionOptions?.messageDisposition
                ? { messageDisposition: admissionOptions.messageDisposition }
                : {}),
              ...(composerDraftRevision !== undefined ? { composerDraftRevision } : {}),
              ...(whisper ? { visibility: whisper.visibility, whisperTo: whisper.whisperTo } : {}),
              ...(replyToId ? { replyTo: replyToId } : {}),
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
        acknowledgeSendComposerDraftConsumption(threadId, admission);
        // A successful send must remain visible even if its Queue socket event was
        // missed. Reuse the same fenced server snapshot as reconnect, not a local bubble.
        if (admission.status === 'queued') void reconcileThreadWithServer(threadId, () => false, 'SendAdmission');
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
    [activeThreadId, createClientId, processCommand, publishError],
  );

  return { handleSend, uploadStatus, uploadError };
}
