import {
  type ArtifactReviewView,
  artifactReviewSchema,
  type MediaContextAttachment,
  reviewedMediaAssetSchema,
  type WorkspaceContentReviewView,
  workspaceContentReviewSchema,
} from '@cat-cafe/shared';
import { createPublicationSurface } from '@/components/workbench/publication-surface';
import { createFilePreviewSurface } from '@/components/workbench/real-surface-adapters';
import { API_URL, apiFetch } from '@/utils/api-client';
import { checked } from './modification-http';

/** A thumbnail is a read of the named owner version, never a raw-path or latest-version substitution. */
export function mediaAttachmentUrl(attachment: MediaContextAttachment): string | null {
  const source = attachment.source;
  if (source.kind === 'publication')
    return `${API_URL}/api/content-publications/${encodeURIComponent(source.contentRef)}/media/${source.ownerRevision}`;
  if (source.kind === 'workspace' || source.kind === 'evolution')
    return `${API_URL}/api/${source.kind === 'workspace' ? 'workspace/' : ''}content-reviews/${encodeURIComponent(source.reviewId)}/media?expectedSourceRevision=${encodeURIComponent(source.expectedSourceRevision)}`;
  if (source.kind === 'artifact-review')
    return `${API_URL}/api/artifact-reviews/${encodeURIComponent(source.reviewId)}/media/${source.round}`;
  return null;
}

/** Read the existing owner before presentation. Review revisions may advance; the original media version may not. */
export async function readMediaAttachmentOwner(attachment: MediaContextAttachment) {
  const source = attachment.source;
  const navigationOrigin = attachment.gallery
    ? {
        kind: 'chat-file-link' as const,
        threadId: attachment.gallery.threadId,
        messageId: attachment.gallery.messageId,
      }
    : undefined;
  if (source.kind === 'publication' || source.kind === 'artifact-review') {
    let contentRef: string, ownerRevision: number;
    if (source.kind === 'artifact-review') {
      const view = await checked<ArtifactReviewView>(
        await apiFetch(`/api/artifact-reviews/${encodeURIComponent(source.reviewId)}`),
      );
      const review = artifactReviewSchema.parse(view.review);
      const round = review.rounds.find((item) => item.number === source.round);
      if (review.reviewId !== source.reviewId || !round) throw new Error('原作品版本已不可读取。');
      ({ contentRef, ownerRevision } = round.asset);
    } else ({ contentRef, ownerRevision } = source);
    const result = await checked<{ asset: unknown }>(
      await apiFetch(`/api/content-publications/${encodeURIComponent(contentRef)}?ownerRevision=${ownerRevision}`),
    );
    const asset = reviewedMediaAssetSchema.parse(result.asset);
    if (
      asset.contentRef !== contentRef ||
      asset.ownerRevision !== ownerRevision ||
      asset.mediaType !== attachment.mediaType
    )
      throw new Error('原作品版本不一致，未打开其它版本。');
    return {
      url: mediaAttachmentUrl(attachment)!,
      media: asset.media,
      target: {
        kind: 'publication' as const,
        contentRef,
        ownerRevision,
        title: attachment.title,
        navigationOrigin,
        ...(source.kind === 'artifact-review' ? { reviewId: source.reviewId } : {}),
      },
      surface: createPublicationSurface({
        contentRef,
        ownerRevision,
        title: attachment.title,
        navigationOrigin,
        ...(source.kind === 'artifact-review' ? { reviewId: source.reviewId } : {}),
      }),
    };
  }
  if (source.kind === 'workspace') {
    const view = await checked<WorkspaceContentReviewView>(
      await apiFetch(`/api/workspace/content-reviews/${encodeURIComponent(source.reviewId)}`),
    );
    const review = workspaceContentReviewSchema.parse(view.review);
    const actual = review.source;
    if (
      review.reviewId !== source.reviewId ||
      actual.kind !== 'media' ||
      actual.revision !== source.expectedSourceRevision ||
      actual.locator.worktreeId !== source.locator.worktreeId ||
      actual.locator.path !== source.locator.path ||
      actual.mime !== attachment.mediaType ||
      view.sourceState !== 'current'
    )
      throw new Error('原版文件已变化或不可读取；保留原圈选，没有套到新版本上。');
    const target = { kind: 'file' as const, ...source.locator, navigationOrigin };
    return {
      url: mediaAttachmentUrl(attachment)!,
      media: actual.media,
      target,
      surface: createFilePreviewSurface(target),
    };
  }
  throw new Error('请从这件作品原来的入口打开；原版本和圈选仍然保留。');
}
