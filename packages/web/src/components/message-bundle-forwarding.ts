import type { MessageBundleSelectionItem } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';

export interface MessageBundleForwardPayload {
  sourceThreadId: string;
  targetThreadId: string;
  targetCats: string[];
  note?: string;
  items: readonly MessageBundleSelectionItem[];
}

export function forwardPayloadFingerprint(payload: MessageBundleForwardPayload): string {
  return JSON.stringify({
    sourceThreadId: payload.sourceThreadId,
    targetThreadId: payload.targetThreadId,
    targetCats: [...payload.targetCats].sort(),
    ...(payload.note?.trim() ? { note: payload.note.trim() } : {}),
    items: payload.items,
  });
}

export function createForwardIdempotencyKey(): string {
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
}

export async function submitMessageBundleForward(
  payload: MessageBundleForwardPayload,
  idempotencyKey: string,
): Promise<string> {
  const response = await apiFetch('/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: '',
      threadId: payload.targetThreadId,
      idempotencyKey,
      messageBundle: {
        sourceThreadId: payload.sourceThreadId,
        ...(payload.note?.trim() ? { note: payload.note.trim() } : {}),
        items: payload.items,
        targetCats: payload.targetCats,
      },
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    messageBundleId?: string;
  };
  if (!response.ok) throw new Error(body.error || `转发失败 (${response.status})`);
  const messageBundleId = body.messageBundleId;
  if (!messageBundleId) throw new Error('转发成功但缺少 Message Bundle identity');
  return messageBundleId;
}
