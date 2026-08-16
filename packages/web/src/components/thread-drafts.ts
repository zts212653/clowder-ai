import { type ContextAttachment, ContextAttachmentsSchema } from '@cat-cafe/shared';

const STORAGE_KEY = 'cat-cafe:thread-drafts';
const REPLY_STORAGE_KEY = 'cat-cafe:thread-reply-drafts';
const CONTEXT_STORAGE_KEY = 'cat-cafe:thread-context-attachment-drafts';
const EMPTY_CONTEXT_ATTACHMENTS: readonly ContextAttachment[] = [];
const contextAttachmentDraftListeners = new Set<() => void>();

/**
 * Reply context persisted alongside the text draft so quoted messages survive
 * thread switching (#934).
 */
export interface DraftReplyContext {
  id: string;
  content: string;
  senderCatId: string | null;
  threadId: string;
}

/**
 * Hydrate text drafts from sessionStorage on module init.
 * sessionStorage is appropriate because drafts are session-scoped — closing
 * the tab should discard them (localStorage would leak stale drafts forever).
 */
function hydrateFromStorage(): Map<string, string> {
  const map = new Map<string, string>();
  if (typeof window === 'undefined') return map;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const entries: [string, string][] = JSON.parse(raw);
      for (const [k, v] of entries) {
        if (typeof k === 'string' && typeof v === 'string' && v.trim()) {
          map.set(k, v);
        }
      }
    }
  } catch {
    // Corrupt or unavailable sessionStorage — start fresh
  }
  return map;
}

function hydrateReplyDrafts(): Map<string, DraftReplyContext> {
  const map = new Map<string, DraftReplyContext>();
  if (typeof window === 'undefined') return map;
  try {
    const raw = window.sessionStorage.getItem(REPLY_STORAGE_KEY);
    if (raw) {
      const entries: [string, DraftReplyContext][] = JSON.parse(raw);
      for (const [k, v] of entries) {
        if (typeof k === 'string' && v && typeof v.id === 'string') {
          map.set(k, v);
        }
      }
    }
  } catch {
    // Corrupt or unavailable — start fresh
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
      const parsed = ContextAttachmentsSchema.safeParse(entry[1]);
      if (parsed.success && parsed.data.length > 0) map.set(entry[0], parsed.data);
    }
  } catch {
    // Corrupt or unavailable — start fresh.
  }
  return map;
}

function hydrateContextAttachmentDrafts(): Map<string, ContextAttachment[]> {
  if (typeof window === 'undefined') return new Map();
  try {
    return parseContextAttachmentDrafts(window.sessionStorage.getItem(CONTEXT_STORAGE_KEY));
  } catch {
    return new Map();
  }
}

function persistToStorage(map: Map<string, string>): void {
  if (typeof window === 'undefined') return;
  try {
    if (map.size === 0) {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...map.entries()]));
    }
  } catch {
    // QuotaExceededError or SecurityError — best effort
  }
}

function persistReplyDrafts(map: Map<string, DraftReplyContext>): void {
  if (typeof window === 'undefined') return;
  try {
    if (map.size === 0) {
      window.sessionStorage.removeItem(REPLY_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(REPLY_STORAGE_KEY, JSON.stringify([...map.entries()]));
    }
  } catch {
    // QuotaExceededError or SecurityError — best effort
  }
}

function persistContextAttachmentDrafts(map: Map<string, ContextAttachment[]>): void {
  if (typeof window === 'undefined') return;
  try {
    if (map.size === 0) {
      window.sessionStorage.removeItem(CONTEXT_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(CONTEXT_STORAGE_KEY, JSON.stringify([...map.entries()]));
    }
  } catch {
    // QuotaExceededError or SecurityError — best effort.
  }
}

export const threadDrafts = hydrateFromStorage();
export const threadImageDrafts = new Map<string, File[]>();
export const threadReplyDrafts = hydrateReplyDrafts();
export const threadContextAttachmentDrafts = hydrateContextAttachmentDrafts();

/** Sync a draft write to sessionStorage. Call after mutating threadDrafts. */
export function syncDraftToStorage(threadId: string, text: string | undefined): void {
  if (text && text.trim()) {
    threadDrafts.set(threadId, text);
  } else {
    threadDrafts.delete(threadId);
  }
  persistToStorage(threadDrafts);
}

/** #934: Save/clear reply context for a thread draft. */
export function syncReplyDraftToStorage(threadId: string, reply: DraftReplyContext | null): void {
  if (reply) {
    threadReplyDrafts.set(threadId, reply);
  } else {
    threadReplyDrafts.delete(threadId);
  }
  persistReplyDrafts(threadReplyDrafts);
}

export function syncContextAttachmentDraftToStorage(threadId: string, attachments: readonly ContextAttachment[]): void {
  const previousSignature = JSON.stringify(threadContextAttachmentDrafts.get(threadId) ?? EMPTY_CONTEXT_ATTACHMENTS);
  const parsed = ContextAttachmentsSchema.safeParse(attachments);
  const next = parsed.success && parsed.data.length > 0 ? parsed.data : EMPTY_CONTEXT_ATTACHMENTS;
  const nextSignature = JSON.stringify(next);
  if (previousSignature === nextSignature) return;
  if (next.length > 0) threadContextAttachmentDrafts.set(threadId, [...next]);
  else threadContextAttachmentDrafts.delete(threadId);
  persistContextAttachmentDrafts(threadContextAttachmentDrafts);
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
