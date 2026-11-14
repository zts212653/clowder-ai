import { z } from 'zod';
import { create } from 'zustand';
import { apiFetch } from '@/utils/api-client';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import { deleteSendAttempt, type SendAttempt, updateStoredSendAttempt } from '@/utils/send-attempt-db';
import type { QueueEntry } from './chat-types';

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
export function patchSendAttempt(attempt: SendAttempt, patch: Partial<SendAttempt>) {
  const current = findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id);
  if (!current) return;
  const next = {
    ...current,
    ...patch,
    ...(current.serverMessageId ? { serverMessageId: current.serverMessageId } : {}),
    ...(current.status === 'delivered'
      ? { status: 'delivered' as const }
      : current.serverMessageId && (patch.status === 'failed' || patch.status === 'unknown')
        ? { status: 'accepted' as const }
        : {}),
  };
  if (
    JSON.stringify({ ...next, files: undefined, previewUrls: undefined }) ===
    JSON.stringify({ ...current, files: undefined, previewUrls: undefined })
  )
    return;
  putSendAttempt(next);
  void updateStoredSendAttempt(next).catch(() => {
    const latest = findSendAttempt(next.ownerUserId, next.threadId, next.id);
    if (latest) putSendAttempt({ ...latest, persistenceError: true });
  });
}
export async function retireSendAttempt(attempt: SendAttempt) {
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
export function observeQueuedSendAttempts(threadId: string, queue: readonly QueueEntry[]) {
  const owner = apiSessionIdentity.getSnapshot().ownerUserId;
  if (!owner) return;
  queue.forEach((entry) => {
    if (!entry.clientMessageId || !entry.messageId || entry.from.kind !== 'user' || entry.from.userId !== owner) return;
    const attempt = findSendAttempt(owner, threadId, entry.clientMessageId);
    if (attempt) patchSendAttempt(attempt, { status: 'accepted', serverMessageId: entry.messageId, error: undefined });
  });
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
  status: z.enum(['unknown', 'accepted', 'delivered']),
  userMessage: z.object({ id: z.string().min(1), timestamp: z.number() }).optional(),
});
export async function checkSendAttempt(attempt: SendAttempt) {
  const current = findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id);
  if (
    !current ||
    current.status === 'checking' ||
    current.status === 'delivered' ||
    apiSessionIdentity.getSnapshot().ownerUserId !== current.ownerUserId
  )
    return;
  const priorStatus = current.status;
  patchSendAttempt(current, { status: 'checking', error: undefined });
  try {
    const response = await apiFetch(
      `/api/threads/${encodeURIComponent(current.threadId)}/message-attempts/${encodeURIComponent(current.id)}`,
    );
    if (!response.ok) throw new Error('未能核对，请稍后重试');
    const receipt = receiptSchema.parse(await response.json());
    if (apiSessionIdentity.getSnapshot().ownerUserId !== current.ownerUserId) return;
    if (receipt.status !== 'unknown' && !receipt.userMessage) throw new Error('接收状态尚未确认');
    patchSendAttempt(current, {
      status: receipt.status === 'unknown' && priorStatus === 'accepted' ? 'accepted' : receipt.status,
      ...(receipt.userMessage ? { serverMessageId: receipt.userMessage.id } : {}),
      error: undefined,
    });
  } catch {
    if (apiSessionIdentity.getSnapshot().ownerUserId === current.ownerUserId)
      patchSendAttempt(current, {
        status: priorStatus === 'accepted' ? 'accepted' : 'unknown',
        error: '未能核对，请稍后重试',
      });
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
        ['unknown', 'accepted'].includes(attempt.status),
    )
    .forEach((attempt) => void checkSendAttempt(attempt));
}
