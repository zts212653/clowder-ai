import { type ContextAttachment, ContextAttachmentDraftsSchema, type ReplyPreview } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';
import { type ApiSessionIdentity, apiSessionIdentity } from '@/utils/api-session-identity';

const STORAGE_KEY = 'cat-cafe:thread-drafts';
const REPLY_STORAGE_KEY = 'cat-cafe:thread-reply-drafts';
const CONTEXT_STORAGE_KEY = 'cat-cafe:thread-context-attachment-drafts';
const EMPTY_CONTEXT_ATTACHMENTS: readonly ContextAttachment[] = [];
const threadDraftListeners = new Set<() => void>();
const contextAttachmentDraftListeners = new Set<() => void>();
let owner = apiSessionIdentity.getSnapshot().ownerUserId;
const imagesByOwner = new Map<string, Map<string, File[]>>();
const ownerKey = (key: string) => (owner ? `${key}:${encodeURIComponent(owner)}` : null);

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
function readEntries(key: string | null): unknown[] {
  if (!key || typeof window === 'undefined') return [];
  try {
    const entries: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]');
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

function writeEntries(key: string, map: Map<string, unknown>): void {
  const scoped = ownerKey(key);
  if (!scoped || typeof window === 'undefined') return;
  if (map.size === 0) window.localStorage.removeItem(scoped);
  else window.localStorage.setItem(scoped, JSON.stringify([...map.entries()]));
}

function hydrateTextDrafts(key = ownerKey(STORAGE_KEY)): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of readEntries(key)) {
    if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string' && entry[1].trim())
      map.set(entry[0], entry[1]);
  }
  return map;
}

function hydrateReplyDrafts(key = ownerKey(REPLY_STORAGE_KEY)): Map<string, DraftReplyContext> {
  const map = new Map<string, DraftReplyContext>();
  for (const entry of readEntries(key)) {
    if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1]?.id === 'string')
      map.set(entry[0], entry[1]);
  }
  return map;
}

export function parseContextAttachmentDrafts(raw: string | null): Map<string, ContextAttachment[]> {
  const map = new Map<string, ContextAttachment[]>();
  try {
    if (!raw) return map;
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries)) return map;
    for (const entry of entries) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
      const parsed = ContextAttachmentDraftsSchema.safeParse(entry[1]);
      if (parsed.success && parsed.data.length > 0) map.set(entry[0], parsed.data);
    }
  } catch {
    // Corrupt or unavailable — start fresh.
  }
  return map;
}

function hydrateContextAttachmentDrafts(key = ownerKey(CONTEXT_STORAGE_KEY)): Map<string, ContextAttachment[]> {
  return parseContextAttachmentDrafts(JSON.stringify(readEntries(key)));
}

function readLegacyThreadDraft(threadId: string) {
  const text = hydrateTextDrafts(STORAGE_KEY).get(threadId) ?? '';
  const reply = hydrateReplyDrafts(REPLY_STORAGE_KEY).get(threadId);
  const contexts = hydrateContextAttachmentDrafts(CONTEXT_STORAGE_KEY).get(threadId) ?? [];
  return text || reply || contexts.length ? { text, reply, contexts } : undefined;
}

export function hasLegacyThreadDraft(threadId: string): boolean {
  return !!readLegacyThreadDraft(threadId);
}

/** A private thread's ownership is checked separately from the writer's explicit confirmation. */
export async function readVerifiedLegacyThreadDraft(threadId: string, session: ApiSessionIdentity) {
  if (!session.ownerUserId || session.ownerUserId === 'system' || threadId === 'default') return undefined;
  if (apiSessionIdentity.getSnapshot() !== session) return undefined;
  const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}`, undefined, { afterCurrentGet: true });
  if (!response.ok) return undefined;
  const thread = (await response.json()) as { id: string; createdBy: string; deletedAt?: number | null };
  if (apiSessionIdentity.getSnapshot() !== session) return undefined;
  if (thread.id !== threadId || thread.createdBy !== session.ownerUserId || thread.deletedAt) return undefined;
  return readLegacyThreadDraft(threadId);
}

export let threadDrafts = hydrateTextDrafts();
export let threadImageDrafts = new Map<string, File[]>();
export let threadReplyDrafts = hydrateReplyDrafts();
export let threadContextAttachmentDrafts = hydrateContextAttachmentDrafts();

apiSessionIdentity.subscribe(() => {
  if (owner) imagesByOwner.set(owner, threadImageDrafts);
  owner = apiSessionIdentity.getSnapshot().ownerUserId;
  threadDrafts = hydrateTextDrafts();
  threadReplyDrafts = hydrateReplyDrafts();
  threadContextAttachmentDrafts = hydrateContextAttachmentDrafts();
  threadImageDrafts = (owner ? imagesByOwner.get(owner) : undefined) ?? new Map();
  for (const listener of threadDraftListeners) listener();
  for (const listener of contextAttachmentDraftListeners) listener();
});

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
  const parsed = ContextAttachmentDraftsSchema.safeParse(attachments);
  if (!parsed.success) return;
  const next = parsed.data;
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
