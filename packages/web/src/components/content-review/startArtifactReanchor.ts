import type { ArtifactReviewRound, WorkspaceContentReviewView } from '@cat-cafe/shared';
import { draftSchema, workspaceReviewDraftKey } from '@/components/workbench/content-review/workspace-review-draft';
import { apiFetch } from '@/utils/api-client';
import { checked } from './modification-http';
import { startReviewReanchor } from './startReviewReanchor';
import type { ReviewDraft } from './useReviewDraft';

/** Before preparing an explicit reanchor, protect the draft already held by that version's canonical ledger. */
export async function startArtifactReanchor(prefix: string, latest: ArtifactReviewRound, draft: ReviewDraft) {
  try {
    if (latest.ledgerRef) {
      const view = await checked<WorkspaceContentReviewView>(
        await apiFetch(`/api/content-reviews/${encodeURIComponent(latest.ledgerRef)}`),
      );
      if (
        view.review.reviewId !== latest.ledgerRef ||
        view.review.source.kind !== 'publication' ||
        view.review.source.publication.contentRef !== latest.asset.contentRef ||
        view.review.source.publication.ownerRevision !== latest.asset.ownerRevision ||
        !view.canWrite
      )
        return 'unavailable';
      const raw = localStorage.getItem(workspaceReviewDraftKey(view));
      const prior = raw ? draftSchema.parse(JSON.parse(raw)) : null;
      if (prior && (prior.body.trim() || prior.target || prior.annotation || prior.action || prior.refresh))
        return 'existing';
    }
    return startReviewReanchor(`${prefix}round:${latest.number}:annotation`, draft);
  } catch {
    return 'unavailable';
  }
}
