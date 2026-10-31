import type { ArtifactReviewCommand } from '@cat-cafe/shared';

export const REVIEW_DRAFT_COMMITTED_EVENT = 'cat-cafe:review-draft-committed';
export interface ReviewDraftCommit {
  key: string;
  body: string;
  submittedDraft?: string;
}
interface ReviewDraftSnapshot extends ReviewDraftCommit {
  saved: string | null;
}
export function captureReviewDraft(prefix: string, command: ArtifactReviewCommand): ReviewDraftSnapshot | null {
  const action = command.action;
  let suffix: string, body: string;
  switch (action.kind) {
    case 'request_image_edit':
      if (action.edit.kind !== 'erase-region') return null;
      suffix = 'annotation';
      body = action.note ?? '';
      break;
    case 'annotate':
      suffix = 'annotation';
      body = action.body;
      break;
    case 'reply':
      suffix = `reply:${action.annotationId}`;
      body = action.body;
      break;
    case 'edit':
      suffix = `edit:${action.annotationId}${action.replyId ? `:${action.replyId}` : ''}`;
      body = action.body;
      break;
    case 'decide':
    case 'submit_feedback':
    case 'reopen':
      suffix = 'decision';
      body = action.explanation;
      break;
    default:
      return null;
  }
  const key = `${prefix}round:${command.round}:${suffix}`;
  try {
    const saved = localStorage.getItem(key);
    const draft = saved ? (JSON.parse(saved) as { body?: unknown }) : null;
    return {
      key,
      body,
      saved,
      ...(draft?.body === body ? { submittedDraft: JSON.stringify(draft) } : {}),
    };
  } catch {
    return null;
  }
}

export function clearCommittedReviewDraft(snapshot: ReviewDraftSnapshot | null): void {
  if (!snapshot?.submittedDraft) return;
  try {
    if (localStorage.getItem(snapshot.key) !== snapshot.saved) return;
    localStorage.removeItem(snapshot.key);
  } catch {
    return;
  }
  window.dispatchEvent(new CustomEvent<ReviewDraftCommit>(REVIEW_DRAFT_COMMITTED_EVENT, { detail: snapshot }));
}

export function reviewDraftIsCurrent(snapshot: ReviewDraftSnapshot | null): boolean {
  if (!snapshot) return true;
  try {
    return localStorage.getItem(snapshot.key) === snapshot.saved;
  } catch {
    return false;
  }
}

export function clearCommittedDraft(key: string, body: string): void {
  try {
    const saved = localStorage.getItem(key);
    if (saved && (JSON.parse(saved) as { body?: unknown }).body === body) localStorage.removeItem(key);
  } catch {
    /* The matching mounted draft still receives the committed receipt. */
  }
  window.dispatchEvent(new CustomEvent<ReviewDraftCommit>(REVIEW_DRAFT_COMMITTED_EVENT, { detail: { key, body } }));
}
