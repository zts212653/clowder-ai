const STORAGE_KEY = 'cat-cafe:thread-drafts';
const REPLY_STORAGE_KEY = 'cat-cafe:thread-reply-drafts';

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

export const threadDrafts = hydrateFromStorage();
export const threadImageDrafts = new Map<string, File[]>();
export const threadReplyDrafts = hydrateReplyDrafts();

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

export function hasPendingThreadDraft(threadId: string): boolean {
  const textDraft = threadDrafts.get(threadId);
  if (typeof textDraft === 'string' && textDraft.trim().length > 0) return true;

  const imageDrafts = threadImageDrafts.get(threadId);
  if (Array.isArray(imageDrafts) && imageDrafts.length > 0) return true;

  // A reply-to without text still counts as a pending draft (#934)
  return threadReplyDrafts.has(threadId);
}
