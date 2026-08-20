import type { ContextAttachment, MessageContent } from '@cat-cafe/shared';
import type { OwnerComposerDraft } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { loadOwnerComposerDraft } from '@/utils/true-recall';

export interface DurableDraftSnapshot {
  text: string;
  imageUrls: string[];
  contextAttachments: ContextAttachment[];
  preservedBlocks: MessageContent[];
  replyTo?: string;
}

export type DurableDraftWriteResult =
  | { kind: 'saved'; revision: number }
  | { kind: 'conflict'; draft: OwnerComposerDraft | null; revision: number }
  | { kind: 'failed' };

const recoveredDraftImageUrl = new WeakMap<File, string>();

export function mergeHydratedDraft(serverText: string, localText: string): string {
  if (!localText.trim() || serverText === localText) return serverText;
  if (!serverText.trim() || localText.includes(serverText)) return localText;
  if (serverText.includes(localText)) return serverText;
  return `${serverText}\n\n${localText}`;
}

export function composerDraftSignature(
  text: string,
  imageUrls: readonly string[],
  contextAttachments: readonly ContextAttachment[],
  preservedBlocks: readonly MessageContent[],
  replyTo?: string,
): string {
  return JSON.stringify([text, imageUrls, contextAttachments, preservedBlocks, replyTo ?? null]);
}

export function imageUrlsFromDraft(draft: OwnerComposerDraft | null): string[] {
  return (draft?.contentBlocks ?? []).flatMap((block) => (block.type === 'image' && block.url ? [block.url] : []));
}

export function contextAttachmentsFromDraft(draft: OwnerComposerDraft | null): ContextAttachment[] {
  return (draft?.contentBlocks ?? [])
    .filter((block) => block.type === 'context_attachment')
    .map((block) => block.attachment);
}

export function preservedBlocksFromDraft(draft: OwnerComposerDraft | null): MessageContent[] {
  return (draft?.contentBlocks ?? []).filter((block) => block.type !== 'image' && block.type !== 'context_attachment');
}

async function downloadDraftImage(url: string, index: number): Promise<File | null> {
  try {
    const response = await apiFetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    const ext = url.split('.').pop() ?? 'png';
    const file = new File([blob], `recalled-${Date.now()}-${index}.${ext}`, {
      type: blob.type || `image/${ext}`,
    });
    recoveredDraftImageUrl.set(file, url);
    return file;
  } catch {
    return null;
  }
}

export async function downloadDraftImages(urls: readonly string[]): Promise<File[]> {
  const restored = await Promise.all(urls.slice(0, 5).map(downloadDraftImage));
  return restored.filter((file): file is File => file !== null);
}

export function getRecoveredDraftImageUrl(file: File | undefined): string | undefined {
  return file ? recoveredDraftImageUrl.get(file) : undefined;
}

function isEmptyDraft(snapshot: DurableDraftSnapshot): boolean {
  return (
    !snapshot.text.trim() &&
    snapshot.imageUrls.length === 0 &&
    snapshot.contextAttachments.length === 0 &&
    snapshot.preservedBlocks.length === 0 &&
    !snapshot.replyTo
  );
}

function buildDraftRequest(revision: number, snapshot: DurableDraftSnapshot): RequestInit {
  if (isEmptyDraft(snapshot)) {
    return {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: revision }),
    };
  }
  const contentBlocks: MessageContent[] = [
    ...snapshot.preservedBlocks,
    ...snapshot.imageUrls.map((url) => ({ type: 'image' as const, url })),
    ...snapshot.contextAttachments.map((attachment) => ({ type: 'context_attachment' as const, attachment })),
  ];
  return {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: revision,
      text: snapshot.text,
      ...(contentBlocks.length > 0 ? { contentBlocks } : {}),
      ...(snapshot.replyTo ? { replyTo: snapshot.replyTo } : {}),
    }),
  };
}

export async function writeOwnerComposerDraft(
  threadId: string,
  revision: number,
  snapshot: DurableDraftSnapshot,
): Promise<DurableDraftWriteResult> {
  try {
    const response = await apiFetch(`/api/threads/${threadId}/composer-draft`, buildDraftRequest(revision, snapshot));
    if (response.status === 409) {
      const current = await loadOwnerComposerDraft(threadId);
      return { kind: 'conflict', ...current };
    }
    if (!response.ok) return { kind: 'failed' };
    const body = (await response.json()) as { revision?: number; draft?: { revision: number } };
    return { kind: 'saved', revision: body.revision ?? body.draft?.revision ?? revision };
  } catch {
    return { kind: 'failed' };
  }
}
