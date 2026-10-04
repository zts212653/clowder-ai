import type {
  ArtifactReviewAnchor,
  WorkspaceContentAnchor,
  WorkspaceContentReview,
  WorkspaceContentSource,
} from '@cat-cafe/shared';
import { artifactReviewAnchorSchema } from '@cat-cafe/shared';
import type {
  WorkspaceContentLocatorV1,
  WorkspaceContentSourceService,
} from '../../workspace/workspace-content-source.js';
import { WorkspaceContentReviewError } from './errors.js';
import { assertWorkspaceMediaAnchor, toWorkspaceReviewSource } from './workspace-review-anchors.js';

export type WorkspaceAnnotationTarget =
  | { readonly kind: 'text_quote'; readonly quote: string }
  | { readonly kind: 'media_anchor'; readonly anchor: ArtifactReviewAnchor };

export type ResolvedWorkspaceSource = { readonly contentRef: string; readonly source: WorkspaceContentSource };

export async function resolveWorkspaceCurrentSource(
  source: WorkspaceContentSourceService,
  input: { readonly userId: string; readonly locator: WorkspaceContentLocatorV1 },
): Promise<ResolvedWorkspaceSource> {
  const description = await source.describe({ principal: { userId: input.userId }, locator: input.locator });
  if (description.kind === 'media') {
    const media = await source.describeMedia({ principal: { userId: input.userId }, locator: input.locator });
    return { contentRef: media.contentRef, source: toWorkspaceReviewSource(media) };
  }
  return { contentRef: description.contentRef, source: toWorkspaceReviewSource(description) };
}

export async function resolveWorkspaceAnnotationTarget(
  source: WorkspaceContentSourceService,
  input: {
    readonly userId: string;
    readonly review: WorkspaceContentReview;
    readonly target: WorkspaceAnnotationTarget;
  },
): Promise<WorkspaceContentAnchor> {
  if (input.target.kind === 'text_quote') {
    if (input.review.source.kind !== 'text') throw new WorkspaceContentReviewError('unsupported_content');
    const resolved = await source.resolveTextQuote({
      principal: { userId: input.userId },
      locator: input.review.source.locator,
      expectedRevision: input.review.source.revision,
      quote: input.target.quote,
    });
    if (resolved.status !== 'attached' || !resolved.anchor) throw new WorkspaceContentReviewError('source_changed');
    return { kind: 'text_quote', baseRevision: input.review.source.revision, ...resolved.anchor };
  }
  if (input.review.source.kind === 'text') throw new WorkspaceContentReviewError('unsupported_content');
  const anchor = artifactReviewAnchorSchema.parse(input.target.anchor);
  assertWorkspaceMediaAnchor(input.review.source, anchor);
  return { baseRevision: input.review.source.revision, anchor };
}
