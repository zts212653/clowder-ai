import type { WorkspaceContentReview, WorkspaceContentReviewView, WorkspaceContentSource } from '@cat-cafe/shared';
import {
  WorkspaceContentSourceError,
  type WorkspaceContentSourceService,
} from '../../workspace/workspace-content-source.js';
import type { WorkspaceReviewPrincipal } from './service.js';
import { isWorkspaceTextAnchor, toWorkspaceReviewSource } from './workspace-review-anchors.js';
import {
  resolveMediaWorkspaceReviewAnnotations,
  resolveTextWorkspaceReviewAnnotations,
  resolveWorkspaceReviewVisualMarks,
} from './workspace-review-annotation-resolution.js';
import { resolveWorkspaceCurrentSource } from './workspace-review-source.js';

export async function readWorkspaceFileReview(
  source: WorkspaceContentSourceService,
  review: WorkspaceContentReview,
  principal: WorkspaceReviewPrincipal,
): Promise<WorkspaceContentReviewView> {
  if (review.source.kind !== 'text' && review.source.kind !== 'media')
    throw new Error('Original content must be read through its own owner');
  let currentSource: WorkspaceContentSource | undefined;
  let currentContentRef: string | undefined;
  let textResolutions: readonly {
    readonly annotationId: string;
    readonly status: 'attached' | 'ambiguous' | 'orphaned';
  }[] = [];
  try {
    if (review.source.kind === 'text') {
      const batch = await source.resolveTextQuotes({
        principal: { userId: principal.userId },
        locator: review.source.locator,
        anchors: review.annotations.flatMap((annotation) =>
          isWorkspaceTextAnchor(annotation.anchor)
            ? [
                {
                  annotationId: annotation.id,
                  baseRevision: annotation.anchor.baseRevision,
                  quote: annotation.anchor.quote,
                  expectedQuoteDigest: annotation.anchor.quoteDigest,
                  expectedContextDigest: annotation.anchor.contextDigest,
                },
              ]
            : [],
        ),
      });
      currentSource = toWorkspaceReviewSource(batch.source);
      currentContentRef = batch.source.contentRef;
      textResolutions = batch.resolutions;
    } else {
      const current = await resolveWorkspaceCurrentSource(source, {
        userId: principal.userId,
        locator: review.source.locator,
      });
      currentSource = current.source;
      currentContentRef = current.contentRef;
    }
  } catch (error) {
    if (error instanceof WorkspaceContentSourceError) {
      return {
        review,
        sourceState: 'unavailable',
        annotationResolutions: review.annotations.map((annotation) => ({
          annotationId: annotation.id,
          status: 'orphaned',
        })),
        visualMarkResolutions: resolveWorkspaceReviewVisualMarks(review, undefined),
        canWrite: false,
      };
    }
    throw error;
  }
  if (currentContentRef !== review.contentRef || currentSource.kind !== review.source.kind) {
    return {
      review,
      sourceState: 'unavailable',
      annotationResolutions: review.annotations.map((annotation) => ({
        annotationId: annotation.id,
        status: 'orphaned',
      })),
      visualMarkResolutions: resolveWorkspaceReviewVisualMarks(review, undefined),
      canWrite: false,
    };
  }
  const sourceState = currentSource.revision === review.source.revision ? 'current' : 'changed';
  const annotationResolutions =
    review.source.kind === 'text'
      ? resolveTextWorkspaceReviewAnnotations(review, currentSource, textResolutions)
      : resolveMediaWorkspaceReviewAnnotations(review, currentSource);
  return {
    review,
    sourceState,
    currentSource,
    annotationResolutions,
    visualMarkResolutions: resolveWorkspaceReviewVisualMarks(review, currentSource),
    canWrite: sourceState === 'current',
  };
}
