import { type ContextAttachment, ContextAttachmentsSchema, type ReplyPreview } from '@cat-cafe/shared';

const STORAGE_KEY = 'cat-cafe:thread-drafts';
const REPLY_STORAGE_KEY = 'cat-cafe:thread-reply-drafts';
const CONTEXT_STORAGE_KEY = 'cat-cafe:thread-context-attachment-drafts';
const EMPTY_CONTEXT_ATTACHMENTS: readonly ContextAttachment[] = [];
const threadDraftListeners = new Set<() => void>();
const contextAttachmentDraftListeners = new Set<() => void>();

/**
 * Reply context persisted alongside the text draft so quoted messages survive
 * thread switching (#934).
 */
export interface DraftReplyContext extends ReplyPreview {
  runtimeAnswerContext?: import('@/stores/chat-types').RuntimeConversationAnswerContext;
  id: string;
  threadId: string;
}

/** Each map is one browser-storage entry; a draft lasts until it is sent or the site data is cleared. */
function readEntries(key: string): unknown[] {
  if (typeof window === 'undefined') return [];
  try {
    const entries: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]');
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

function writeEntries(key: string, map: Map<string, unknown>): void {
  if (map.size === 0) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, JSON.stringify([...map.entries()]));
}

function hydrateTextDrafts(): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of readEntries(STORAGE_KEY)) {
    if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string' && entry[1].trim())
      map.set(entry[0], entry[1]);
  }
  return map;
}

function hydrateReplyDrafts(): Map<string, DraftReplyContext> {
  const map = new Map<string, DraftReplyContext>();
  for (const entry of readEntries(REPLY_STORAGE_KEY)) {
    if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1]?.id === 'string')
      map.set(entry[0], entry[1]);
  }
  return map;
}

function hydrateContextAttachmentDrafts(): Map<string, ContextAttachment[]> {
  const map = new Map<string, ContextAttachment[]>();
  for (const entry of readEntries(CONTEXT_STORAGE_KEY)) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
    const parsed = ContextAttachmentsSchema.safeParse(entry[1]);
    if (parsed.success && parsed.data.length > 0) map.set(entry[0], parsed.data);
  }
  return map;
}

export const threadDrafts = hydrateTextDrafts();
export const threadImageDrafts = new Map<string, File[]>();
export const threadReplyDrafts = hydrateReplyDrafts();
export const threadContextAttachmentDrafts = hydrateContextAttachmentDrafts();

export function getThreadDraft(threadId: string | undefined): string {
  return threadId ? (threadDrafts.get(threadId) ?? '') : '';
}

export function subscribeThreadDrafts(listener: () => void): () => void {
  threadDraftListeners.add(listener);
  return () => threadDraftListeners.delete(listener);
}

/** The text draft of one conversation; an empty text removes it. */
export function syncDraftToStorage(threadId: string, text: string | undefined): void {
  const next = text?.trim() ? text : undefined;
  if (threadDrafts.get(threadId) === next) return;
  if (next !== undefined) threadDrafts.set(threadId, next);
  else threadDrafts.delete(threadId);
  writeEntries(STORAGE_KEY, threadDrafts);
  for (const listener of threadDraftListeners) listener();
}

/** #934: Save/clear reply context for a thread draft. */
export function syncReplyDraftToStorage(threadId: string, reply: DraftReplyContext | null): void {
  if (JSON.stringify(threadReplyDrafts.get(threadId) ?? null) === JSON.stringify(reply)) return;
  if (reply) {
    threadReplyDrafts.set(threadId, reply);
  } else {
    threadReplyDrafts.delete(threadId);
  }
  writeEntries(REPLY_STORAGE_KEY, threadReplyDrafts);
  for (const listener of threadDraftListeners) listener();
}

export function syncContextAttachmentDraftToStorage(threadId: string, attachments: readonly ContextAttachment[]): void {
  const previousSignature = JSON.stringify(threadContextAttachmentDrafts.get(threadId) ?? EMPTY_CONTEXT_ATTACHMENTS);
  const parsed = ContextAttachmentsSchema.safeParse(attachments);
  const next = parsed.success && parsed.data.length > 0 ? parsed.data : EMPTY_CONTEXT_ATTACHMENTS;
  const nextSignature = JSON.stringify(next);
  if (previousSignature === nextSignature) return;
  if (next.length > 0) threadContextAttachmentDrafts.set(threadId, [...next]);
  else threadContextAttachmentDrafts.delete(threadId);
  writeEntries(CONTEXT_STORAGE_KEY, threadContextAttachmentDrafts);
  for (const listener of contextAttachmentDraftListeners) listener();
}

export function getContextAttachmentDraft(threadId: string): readonly ContextAttachment[] {
  return threadContextAttachmentDrafts.get(threadId) ?? EMPTY_CONTEXT_ATTACHMENTS;
}

export function subscribeContextAttachmentDrafts(listener: () => void): () => void {
  contextAttachmentDraftListeners.add(listener);
  return () => contextAttachmentDraftListeners.delete(listener);
}

export function hasPendingThreadDraft(threadId: string): boolean {
  const textDraft = threadDrafts.get(threadId);
  if (typeof textDraft === 'string' && textDraft.trim().length > 0) return true;

  const imageDrafts = threadImageDrafts.get(threadId);
  if (Array.isArray(imageDrafts) && imageDrafts.length > 0) return true;

  const contextDrafts = threadContextAttachmentDrafts.get(threadId);
  if (Array.isArray(contextDrafts) && contextDrafts.length > 0) return true;

  // A reply-to without text still counts as a pending draft (#934)
  return threadReplyDrafts.has(threadId);
}
