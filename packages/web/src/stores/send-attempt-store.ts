import { z } from 'zod';
import { create } from 'zustand';
import { composerDraftIsTransferred } from '@/components/durable-composer-draft-helpers';
import { apiFetch } from '@/utils/api-client';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import {
  deleteSendAttempt,
  loadSendAttempts,
  type SendAttempt,
  updateStoredSendAttempt,
} from '@/utils/send-attempt-db';
import { loadOwnerComposerDraft } from '@/utils/true-recall';
import type { OwnerComposerDraft, QueueEntry } from './chat-types';
import { useChatStore } from './chatStore';

export const useSendAttemptStore = create<{ attempts: SendAttempt[] }>(() => ({ attempts: [] }));
export function findSendAttempt(ownerUserId: string, threadId: string, id: string) {
  return useSendAttemptStore
    .getState()
    .attempts.find(
      (attempt) => attempt.ownerUserId === ownerUserId && attempt.threadId === threadId && attempt.id === id,
    );
}
export function putSendAttempt(attempt: SendAttempt) {
  useSendAttemptStore.setState((state) => ({
    attempts: [
      ...state.attempts.filter(
        (item) =>
          item.ownerUserId !== attempt.ownerUserId || item.threadId !== attempt.threadId || item.id !== attempt.id,
      ),
      attempt,
    ],
  }));
}
export function patchSendAttempt(attempt: SendAttempt, patch: Partial<SendAttempt>): Promise<void> | undefined {
  const current = findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id);
  if (!current) return;
  const next = {
    ...current,
    ...patch,
    ...(current.serverMessageId ? { serverMessageId: current.serverMessageId } : {}),
    ...(current.status === 'delivered' || patch.status === 'delivered'
      ? { status: 'delivered' as const }
      : current.status === 'canceled' || patch.status === 'canceled'
        ? { status: 'canceled' as const }
        : current.serverMessageId && (patch.status === 'failed' || patch.status === 'unknown')
          ? { status: 'accepted' as const }
          : {}),
  };
  if (
    JSON.stringify({ ...next, files: undefined, previewUrls: undefined }) ===
    JSON.stringify({ ...current, files: undefined, previewUrls: undefined })
  )
    return;
  if (next.status === 'failed' || next.status === 'canceled') {
    return updateStoredSendAttempt(next).then(
      () => {
        const latest = findSendAttempt(next.ownerUserId, next.threadId, next.id);
        if (latest === current) putSendAttempt(next);
        else if (latest) return patchSendAttempt(latest, patch);
      },
      () => {
        const latest = findSendAttempt(next.ownerUserId, next.threadId, next.id);
        if (latest === current) putSendAttempt({ ...next, persistenceError: true });
        else if (latest) return patchSendAttempt(latest, { ...patch, persistenceError: true });
      },
    );
  }
  putSendAttempt(next);
  return updateStoredSendAttempt(next).catch(() => {
    const latest = findSendAttempt(next.ownerUserId, next.threadId, next.id);
    if (latest) putSendAttempt({ ...latest, persistenceError: true });
  });
}
export async function isPreparedComposerDraft(threadId: string, draft: OwnerComposerDraft, revision: number) {
  const owner = apiSessionIdentity.getSnapshot().ownerUserId;
  if (!owner) return false;
  const attempts = await loadSendAttempts(owner, threadId).catch(() => []);
  if (apiSessionIdentity.getSnapshot().ownerUserId !== owner) throw new Error('Draft owner changed');
  return attempts.some((attempt) => composerDraftIsTransferred(draft, revision, attempt));
}
const retiringAttempts = new Map<string, Promise<void>>();
export function retireSendAttempt(attempt: SendAttempt) {
  const key = JSON.stringify([attempt.ownerUserId, attempt.threadId, attempt.id]);
  const pending = retiringAttempts.get(key);
  if (pending) return pending;
  const retirement = (async () => {
    if (apiSessionIdentity.getSnapshot().ownerUserId !== attempt.ownerUserId) return;
    if (attempt.composerDraftRevision !== undefined) {
      const current = await loadOwnerComposerDraft(attempt.threadId);
      if (apiSessionIdentity.getSnapshot().ownerUserId !== attempt.ownerUserId) return;
      if (current.draft && current.revision === attempt.composerDraftRevision) return;
    }
    await discardSendAttempt(attempt);
  })().finally(() => retiringAttempts.delete(key));
  retiringAttempts.set(key, retirement);
  return retirement;
}
async function discardSendAttempt(attempt: SendAttempt) {
  // Keep the durable copy if deletion fails; the next canonical read can retire it again.
  await deleteSendAttempt(attempt);
  useSendAttemptStore.setState((state) => ({
    attempts: state.attempts.filter(
      (item) =>
        item.ownerUserId !== attempt.ownerUserId || item.threadId !== attempt.threadId || item.id !== attempt.id,
    ),
  }));
  attempt.previewUrls?.forEach((url) => URL.revokeObjectURL(url));
}
export async function observeCanceledSendAttempts(
  threadId: string,
  messageIds: readonly string[],
  removal?: 'deleted' | 'recalled',
) {
  const owner = apiSessionIdentity.getSnapshot().ownerUserId;
  const attempts = useSendAttemptStore
    .getState()
    .attempts.filter(
      (attempt) =>
        attempt.ownerUserId === owner &&
        attempt.threadId === threadId &&
        attempt.serverMessageId &&
        messageIds.includes(attempt.serverMessageId),
    );
  await Promise.all(
    attempts.map(async (attempt) => {
      if (!removal) return checkSendAttempt(attempt, true);
      if (removal === 'recalled') return discardSendAttempt(attempt);
      await patchSendAttempt(attempt, { removed: true });
      await retireSendAttempt(attempt).catch(() => {});
    }),
  );
}
export function observeQueuedSendAttempts(threadId: string, queue: readonly QueueEntry[]) {
  const owner = apiSessionIdentity.getSnapshot().ownerUserId;
  if (!owner) return;
  queue.forEach((entry) => {
    if (!entry.clientMessageId || !entry.messageId || entry.from.kind !== 'user' || entry.from.userId !== owner) return;
    const attempt = findSendAttempt(owner, threadId, entry.clientMessageId);
    if (attempt) patchSendAttempt(attempt, { status: 'accepted', serverMessageId: entry.messageId, error: undefined });
  });
  useSendAttemptStore
    .getState()
    .attempts.filter(
      (attempt) =>
        attempt.ownerUserId === owner &&
        attempt.threadId === threadId &&
        (attempt.status === 'accepted' || attempt.status === 'checking') &&
        !queue.some((entry) => entry.messageId === attempt.serverMessageId || entry.clientMessageId === attempt.id),
    )
    .forEach((attempt) => void checkSendAttempt(attempt, true));
}
export function observeDeliveredSendAttempts(
  threadId: string,
  messages: readonly { id: string; clientMessageId?: string }[],
) {
  const owner = apiSessionIdentity.getSnapshot().ownerUserId;
  if (!owner) return;
  messages.forEach((message) => {
    if (!message.clientMessageId) return;
    const attempt = findSendAttempt(owner, threadId, message.clientMessageId);
    if (attempt) patchSendAttempt(attempt, { status: 'delivered', serverMessageId: message.id, error: undefined });
  });
}
const receiptSchema = z.object({
  status: z.enum(['unknown', 'accepted', 'delivered', 'canceled', 'removed']),
  userMessage: z.object({ id: z.string().min(1), timestamp: z.number() }).optional(),
});
const checkingAttempts = new Map<string, boolean>();
export async function checkSendAttempt(attempt: SendAttempt, afterDeletion = false) {
  const key = JSON.stringify([attempt.ownerUserId, attempt.threadId, attempt.id]);
  const current = findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id);
  if (
    !current ||
    current.removed ||
    (current.status === 'delivered' && !afterDeletion) ||
    apiSessionIdentity.getSnapshot().ownerUserId !== current.ownerUserId
  )
    return;
  if (checkingAttempts.has(key)) {
    if (afterDeletion) checkingAttempts.set(key, true);
    return;
  }
  if (current.status === 'checking') return;
  const priorStatus = current.status;
  checkingAttempts.set(key, false);
  patchSendAttempt(current, { status: 'checking', error: undefined });
  try {
    const response = await apiFetch(
      `/api/threads/${encodeURIComponent(current.threadId)}/message-attempts/${encodeURIComponent(current.id)}`,
    );
    if (!response.ok) throw new Error('未能核对，请稍后重试');
    const receipt = receiptSchema.parse(await response.json());
    if (apiSessionIdentity.getSnapshot().ownerUserId !== current.ownerUserId) return;
    if (receipt.status !== 'unknown' && !receipt.userMessage) throw new Error('接收状态尚未确认');
    if (receipt.status === 'removed') {
      await patchSendAttempt(current, { removed: true });
      await retireSendAttempt(current).catch(() => {});
      return;
    }
    await patchSendAttempt(current, {
      status: receipt.status === 'unknown' && priorStatus === 'accepted' ? 'accepted' : receipt.status,
      ...(receipt.userMessage ? { serverMessageId: receipt.userMessage.id } : {}),
      error: undefined,
    });
    if (receipt.status === 'delivered') useChatStore.getState().requestStreamCatchUp(current.threadId);
  } catch {
    if (apiSessionIdentity.getSnapshot().ownerUserId === current.ownerUserId)
      patchSendAttempt(current, {
        status: priorStatus === 'accepted' ? 'accepted' : 'unknown',
        error: '未能核对，请稍后重试',
      });
  } finally {
    const latest = findSendAttempt(current.ownerUserId, current.threadId, current.id);
    if (latest?.status === 'checking') await patchSendAttempt(latest, { status: priorStatus });
    const changedWhileChecking = checkingAttempts.get(key);
    checkingAttempts.delete(key);
    if (changedWhileChecking) void checkSendAttempt(current, true);
  }
}
export function recoverSendAttempts(threadId?: string) {
  const owner = apiSessionIdentity.getSnapshot().ownerUserId;
  useSendAttemptStore
    .getState()
    .attempts.filter(
      (attempt) =>
        attempt.ownerUserId === owner &&
        (!threadId || attempt.threadId === threadId) &&
        ['unknown', 'accepted', 'canceled'].includes(attempt.status),
    )
    .forEach((attempt) => void checkSendAttempt(attempt));
}
