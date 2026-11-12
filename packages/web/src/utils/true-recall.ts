import type { ComposerDraftInsert, TrueRecallResponse } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';

export class TrueRecallRequestError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === 'string' ? body.error : '撤回并重新编辑失败，请重试');
    this.name = 'TrueRecallRequestError';
    this.status = status;
    this.code = typeof body.code === 'string' ? body.code : undefined;
  }
}

interface InFlightRecall {
  messageId: string;
  request: Promise<TrueRecallResponse | null>;
}

const inFlightRecall = new Map<string, InFlightRecall>();

/**
 * The recall endpoint hands the message back through the person's server draft slot, which needs that slot's current
 * revision. The input keeps its own draft in the browser; the recalled message is added to it (composerInsertFromRecall).
 */
async function executeTrueRecall(input: { threadId: string; messageId: string }): Promise<TrueRecallResponse> {
  const slot = await apiFetch(`/api/threads/${input.threadId}/composer-draft`);
  const current = (await slot.json().catch(() => ({}))) as Record<string, unknown>;
  if (!slot.ok) throw new TrueRecallRequestError(slot.status, current);
  const response = await apiFetch(`/api/messages/${input.messageId}/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: input.threadId, expectedDraftRevision: current.revision, merge: 'replace' }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new TrueRecallRequestError(response.status, body);
  return body as unknown as TrueRecallResponse;
}

export async function requestTrueRecall(input: {
  threadId: string;
  messageId: string;
}): Promise<TrueRecallResponse | null> {
  // Every recall moves the same draft slot's revision. Serialize the whole
  // thread, not only duplicate controls for one source message.
  const key = input.threadId;
  const existing = inFlightRecall.get(key);
  if (existing) {
    await existing.request.catch(() => null);
    if (existing.messageId === input.messageId) return null;
    return requestTrueRecall(input);
  }
  const request = executeTrueRecall(input);
  const active = { messageId: input.messageId, request };
  inFlightRecall.set(key, active);
  try {
    return await request;
  } finally {
    if (inFlightRecall.get(key) === active) inFlightRecall.delete(key);
  }
}

export function composerInsertFromRecall(result: TrueRecallResponse): ComposerDraftInsert | null {
  const draft = result.draft;
  if (!draft) return null;
  const imageUrls = (draft.contentBlocks ?? []).flatMap((block) =>
    block.type === 'image' && block.url ? [block.url] : [],
  );
  const contextAttachments = (draft.contentBlocks ?? [])
    .filter((block) => block.type === 'context_attachment')
    .map((block) => block.attachment);
  return {
    threadId: draft.threadId,
    text: draft.text,
    ...(imageUrls.length > 0 ? { imageUrls } : {}),
    ...(contextAttachments.length > 0 ? { contextAttachments } : {}),
    ...(draft.replyTo ? { replyToId: draft.replyTo } : {}),
  };
}
