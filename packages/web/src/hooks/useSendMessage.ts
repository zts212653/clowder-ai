'use client';

import type { ContextAttachment, MessageWorkDisposition } from '@cat-cafe/shared';
import { FileContentSchema, ImageContentSchema, TextContentSchema } from '@cat-cafe/shared';
import { routingConfirmationRequiredSchema } from '@cat-cafe/shared/routing-preview';
import { useCallback, useState } from 'react';
import { z } from 'zod';
import {
  acknowledgeSendComposerDraftConsumption,
  type ComposerDraftConsumption,
} from '@/components/composer-draft-consumption';
import { observeComposerDraft } from '@/components/composer-draft-flush-registry';
import { useOptionalConfirm } from '@/components/useConfirm';
import { useChatCommands } from '@/hooks/useChatCommands';
import { type ChatMessage as ChatMessageData, useChatStore } from '@/stores/chatStore';
import {
  checkSendAttempt,
  findSendAttempt,
  patchSendAttempt,
  putSendAttempt,
  useSendAttemptStore,
} from '@/stores/send-attempt-store';
import { apiFetch } from '@/utils/api-client';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import { type SendAttempt, saveSendAttempt } from '@/utils/send-attempt-db';
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
  /** Ordinary conversation composer only; other admission owners retain their existing recovery. */
  localAttempt?: boolean;
  onPrepared?: (localDurableAttempt: boolean) => void;
}

interface MessageAdmissionResponse {
  status?: string;
  gameThreadId?: string;
  composerDraftConsumption?: ComposerDraftConsumption;
  userMessageId?: string;
  userMessage?: unknown;
}

const storedReceiptSchema = z.object({
  id: z.string().min(1),
  timestamp: z.number(),
  contentBlocks: z.array(z.union([TextContentSchema, ImageContentSchema, FileContentSchema])).optional(),
});

/**
 * Submit one durable Queue input. History and active-invocation UI are projected
 * exclusively from lifecycle events after server admission; this hook never creates
 * an optimistic History bubble or a client-owned invocation.
 */
export function useSendMessage(activeThreadId?: string) {
  const confirm = useOptionalConfirm();
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
      const localAttempt = admissionOptions?.localAttempt === true;
      const ownerUserId = apiSessionIdentity.getSnapshot().ownerUserId ?? '';
      const existing =
        localAttempt && admissionOptions?.idempotencyKey
          ? findSendAttempt(ownerUserId, threadId, admissionOptions.idempotencyKey)
          : undefined;
      if (existing && existing.status !== 'failed') return false;
      if (existing) {
        content = existing.content;
        images = existing.files;
        whisper = existing.whisper;
        replyToId = existing.replyTo;
        contextAttachments = existing.contextAttachments;
        explicitTargetCats = existing.explicitTargetCats;
      }
      const composerDraftRevision =
        existing?.composerDraftRevision ??
        (admissionOptions?.consumeComposerDraft ? observeComposerDraft(threadId)?.revision : undefined);
      const messageDisposition = existing?.messageDisposition ?? admissionOptions?.messageDisposition;
      const hasImages = Boolean(images?.length);
      setUploadError(null);
      setUploadStatus(hasImages ? 'uploading' : 'idle');

      const wasCommand = !existing && (await processCommand(content, threadId));
      if (wasCommand) {
        admissionOptions?.onPrepared?.(false);
        return false;
      }

      const clientMessageId = admissionOptions?.idempotencyKey ?? createClientId();
      let attempt: SendAttempt | undefined = localAttempt
        ? {
            ...existing,
            id: clientMessageId,
            ownerUserId,
            threadId,
            content,
            files: images ?? [],
            timestamp: existing?.timestamp ?? Date.now(),
            status: 'preparing',
            replyTo: replyToId,
            contextAttachments,
            explicitTargetCats,
            whisper,
            messageDisposition,
            composerDraftRevision,
            previewUrls: existing?.previewUrls ?? (images ?? []).map((file) => URL.createObjectURL(file)),
            error: undefined,
          }
        : undefined;
      if (attempt) putSendAttempt(attempt);
      let submitted = false;
      let rejected = false;
      let retryable = true;

      try {
        if (attempt) {
          if (!attempt.ownerUserId) {
            await apiFetch('/api/session');
            const verifiedOwner = apiSessionIdentity.getSnapshot().ownerUserId;
            if (!verifiedOwner) throw new Error('身份尚未确认，内容已保留');
            useSendAttemptStore.setState((state) => ({ attempts: state.attempts.filter((item) => item !== attempt) }));
            attempt = { ...attempt, ownerUserId: verifiedOwner };
            putSendAttempt(attempt);
          }
          await saveSendAttempt(attempt);
          if (apiSessionIdentity.getSnapshot().ownerUserId !== attempt.ownerUserId)
            throw new Error('身份已变更，内容已保留');
          patchSendAttempt(attempt, { status: 'sending' });
          admissionOptions?.onPrepared?.(true);
        }
        const submit = (confirmedTargetCats?: string[]) => {
          if (attempt && apiSessionIdentity.getSnapshot().ownerUserId !== attempt.ownerUserId)
            throw new Error('身份已变更，内容已保留');
          submitted = true;
          if (hasImages) {
            const formData = new FormData();
            formData.append('content', content);
            formData.append('threadId', threadId);
            formData.append('idempotencyKey', clientMessageId);
            if (messageDisposition) {
              formData.append('messageDisposition', messageDisposition);
            }
            for (const catId of explicitTargetCats ?? []) formData.append('mentions', catId);
            for (const catId of confirmedTargetCats ?? []) formData.append('confirmedTargetCats', catId);
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
            return apiFetch('/api/messages', { method: 'POST', body: formData });
          } else {
            return apiFetch('/api/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                content,
                threadId,
                idempotencyKey: clientMessageId,
                ...(messageDisposition ? { messageDisposition } : {}),
                ...(composerDraftRevision !== undefined ? { composerDraftRevision } : {}),
                ...(whisper ? { visibility: whisper.visibility, whisperTo: whisper.whisperTo } : {}),
                ...(replyToId ? { replyTo: replyToId } : {}),
                ...(explicitTargetCats?.length ? { mentions: explicitTargetCats } : {}),
                ...(confirmedTargetCats ? { confirmedTargetCats } : {}),
                ...(contextAttachments?.length ? { contextAttachments } : {}),
              }),
            });
          }
        };
        let response = await submit(existing?.confirmedTargetCats);
        if (response.status === 409) {
          const payload: unknown = await response
            .clone()
            .json()
            .catch(() => null);
          const redirect = routingConfirmationRequiredSchema.safeParse(payload);
          if (redirect.success) {
            rejected = true;
            if (!confirm) {
              retryable = false;
              throw new Error('需要在聊天页面确认实际接收者后才能改发。');
            }
            const unavailable = redirect.data.unavailable.map((member) => member.displayName).join('、');
            const targets = redirect.data.targets.map((member) => member.displayName).join('、');
            const accepted = await confirm({
              title: '确认改发角色',
              message: `${unavailable}当前不可用。是否将这条消息改发给${targets}？`,
              confirmLabel: `改发给${targets}`,
              cancelLabel: '取消发送',
            });
            if (!accepted) {
              setUploadStatus('idle');
              if (attempt)
                await patchSendAttempt(attempt, { status: 'failed', error: '已取消，未发出', retryable: true });
              return false;
            }
            if (attempt)
              patchSendAttempt(attempt, { confirmedTargetCats: redirect.data.targets.map((member) => member.catId) });
            rejected = false;
            response = await submit(redirect.data.targets.map((member) => member.catId));
          }
        }

        if (!response.ok) {
          rejected = response.status >= 400 && response.status < 500 && response.status !== 408;
          retryable = response.status === 429;
          const body = await response.json().catch(() => null);
          throw new Error(body?.detail ?? body?.error ?? `Server error: ${response.status}`);
        }

        const admission = (await response.json().catch(() => null)) as MessageAdmissionResponse | null;
        if (admission?.status !== 'game_started' && admission?.status !== 'queued') {
          throw new Error('Server did not return a canonical Queue admission');
        }
        acknowledgeSendComposerDraftConsumption(threadId, admission);
        if (attempt && apiSessionIdentity.getSnapshot().ownerUserId === attempt.ownerUserId) {
          const receipt = storedReceiptSchema.safeParse(admission.userMessage);
          const serverMessageId = receipt.success ? receipt.data.id : admission.userMessageId;
          patchSendAttempt(attempt, {
            status: serverMessageId ? 'accepted' : 'unknown',
            ...(serverMessageId ? { serverMessageId } : {}),
            ...(receipt.success && receipt.data.contentBlocks ? { contentBlocks: receipt.data.contentBlocks } : {}),
          });
          if (!serverMessageId) void checkSendAttempt(attempt);
        }
        // A successful send must remain visible even if its Queue socket event was
        // missed. Reuse the same fenced server snapshot as reconnect, not a local bubble.
        if (admission.status === 'queued') void reconcileThreadWithServer(threadId, () => false, 'SendAdmission');
        setUploadStatus('idle');
        setUploadError(null);
        window.dispatchEvent(new CustomEvent('guide:confirm', { detail: { target: 'chat.input' } }));
        return true;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        if (attempt) {
          await patchSendAttempt(attempt, {
            status: !submitted || rejected ? 'failed' : 'unknown',
            error: !submitted ? '未能安全保存，内容仍在输入框' : rejected ? errorMessage : undefined,
            retryable,
          });
          setUploadStatus('idle');
          if (submitted && !rejected) void checkSendAttempt(attempt);
          return false;
        }
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
    [activeThreadId, confirm, createClientId, processCommand, publishError],
  );

  return { handleSend, uploadStatus, uploadError };
}
