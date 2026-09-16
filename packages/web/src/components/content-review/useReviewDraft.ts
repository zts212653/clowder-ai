'use client';
import { type ArtifactReviewAnchor, artifactReviewAnchorSchema } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { REVIEW_DRAFT_COMMITTED_EVENT, type ReviewDraftCommit } from './review-draft-commit';

const draftSchema = z
  .object({
    body: z.string().max(8000),
    anchor: artifactReviewAnchorSchema.nullable(),
    reanchoredFrom: z
      .object({ round: z.number().int().positive(), annotationId: z.string().min(1).max(128) })
      .optional(),
  })
  .strict();
export type ReviewDraft = {
  body: string;
  anchor: ArtifactReviewAnchor | null;
  reanchoredFrom?: { round: number; annotationId: string };
};
const empty: ReviewDraft = { body: '', anchor: null };

/** Mount only after a fresh owner read. No unmount writer can recreate a draft after authority revocation. */
export function useReviewDraft(key: string) {
  const [draft, setDraft] = useState<ReviewDraft | null>(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved ? draftSchema.parse(JSON.parse(saved)) : null;
    } catch {
      return null;
    }
  });
  const [storageError, setStorageError] = useState(false);
  useEffect(() => {
    const committed = (event: Event) => {
      const detail = (event as CustomEvent<ReviewDraftCommit>).detail;
      if (detail?.key === key) setDraft((current) => (current?.body === detail.body ? null : current));
    };
    window.addEventListener(REVIEW_DRAFT_COMMITTED_EVENT, committed);
    return () => window.removeEventListener(REVIEW_DRAFT_COMMITTED_EVENT, committed);
  }, [key]);
  function update(next: ReviewDraft) {
    setDraft(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }
  function clear() {
    setDraft(null);
    try {
      localStorage.removeItem(key);
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }
  function initialize(next: ReviewDraft) {
    if (draft === null) update(next);
  }
  return { draft: draft ?? empty, hasDraft: draft !== null, update, initialize, clear, storageError };
}
