import type { ReviewDraft } from './useReviewDraft';

export function startReviewReanchor(key: string, draft: ReviewDraft): 'created' | 'existing' | 'unavailable' {
  try {
    if (localStorage.getItem(key) !== null) return 'existing';
    localStorage.setItem(key, JSON.stringify(draft));
    return 'created';
  } catch {
    return 'unavailable';
  }
}
