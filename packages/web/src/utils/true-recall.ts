import { flushComposerDraft } from '@/components/composer-draft-flush-registry';
import type { OwnerComposerDraft, TrueRecallResponse } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';

export class TrueRecallRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly actualRevision?: number;

  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === 'string' ? body.error : '撤回并重新编辑失败，请重试');
    this.name = 'TrueRecallRequestError';
    this.status = status;
    this.code = typeof body.code === 'string' ? body.code : undefined;
    this.actualRevision = typeof body.actualRevision === 'number' ? body.actualRevision : undefined;
  }
}

export async function loadOwnerComposerDraft(
  threadId: string,
): Promise<{ draft: OwnerComposerDraft | null; revision: number }> {
  const response = await apiFetch(`/api/threads/${threadId}/composer-draft`);
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new TrueRecallRequestError(response.status, body);
  return body as unknown as { draft: OwnerComposerDraft | null; revision: number };
}

export function hasComposerDraftContent(draft: OwnerComposerDraft | null): boolean {
  return Boolean(draft && (draft.text.trim() || draft.contentBlocks?.length || draft.replyTo));
}

interface InFlightRecall {
  messageId: string;
  request: Promise<TrueRecallResponse | null>;
}

const inFlightRecall = new Map<string, InFlightRecall>();

async function executeTrueRecall(input: {
  threadId: string;
  messageId: string;
  confirmAppend: (draft: OwnerComposerDraft) => boolean;
}): Promise<TrueRecallResponse | null> {
  const clientSnapshot = await flushComposerDraft(input.threadId);
  const current = await loadOwnerComposerDraft(input.threadId);
  const append = hasComposerDraftContent(current.draft);
  if (append && current.draft && !input.confirmAppend(current.draft)) return null;

  const response = await apiFetch(`/api/messages/${input.messageId}/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      threadId: input.threadId,
      expectedDraftRevision: current.revision,
      merge: append ? 'append' : 'replace',
    }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new TrueRecallRequestError(response.status, body);
  return { ...(body as unknown as TrueRecallResponse), ...(clientSnapshot ? { clientSnapshot } : {}) };
}

export async function requestTrueRecall(input: {
  threadId: string;
  messageId: string;
  confirmAppend: (draft: OwnerComposerDraft) => boolean;
}): Promise<TrueRecallResponse | null> {
  // Every recall mutates the same owner+thread draft revision. Serialize the
  // whole thread, not only duplicate controls for one source message.
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

export function composerInsertFromRecall(result: TrueRecallResponse) {
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
    authoritative: true as const,
    serverRevision: draft.revision,
    ...(result.clientSnapshot ? { clientSnapshot: result.clientSnapshot } : {}),
    ...(result.insertedRange ? { selectionRange: result.insertedRange } : {}),
    ...(imageUrls.length > 0 ? { imageUrls } : {}),
    ...(contextAttachments.length > 0 ? { contextAttachments } : {}),
    ...(draft.replyTo ? { replyToId: draft.replyTo } : {}),
  };
}
