import type { ReviewDraft } from './useReviewDraft';

/**
 * Protection is for what the reader could lose. A draft emptied in the shared composer (which has no
 * separate clear action) holds nothing to keep; anything unreadable or unknown is still protected.
 */
function holdsUnsavedContent(saved: string): boolean {
  try {
    const value: unknown = JSON.parse(saved);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
    const { body, anchor, reanchoredFrom, ...unknownFields } = value as Record<string, unknown>;
    if (Object.keys(unknownFields).length > 0 || typeof body !== 'string') return true;
    return body.trim() !== '' || anchor !== null || reanchoredFrom !== undefined;
  } catch {
    return true;
  }
}

export function startReviewReanchor(key: string, draft: ReviewDraft): 'created' | 'existing' | 'unavailable' {
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null && holdsUnsavedContent(saved)) return 'existing';
    localStorage.setItem(key, JSON.stringify(draft));
    return 'created';
  } catch {
    return 'unavailable';
  }
}
