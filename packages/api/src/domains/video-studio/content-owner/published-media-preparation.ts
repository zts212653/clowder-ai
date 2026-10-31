import type { ReviewedMediaAsset } from '@cat-cafe/shared';
import { MediaOwnerError } from './media-errors.js';
import { findMessagePublicationLanding, MessagePublicationChoiceRequired } from './message-publication-landing.js';
import { publishedMediaContentRef, samePublicationScope } from './publication.js';
import type { MediaReviewPrincipal, PublishedMediaAccess } from './published-media-access.js';
import { probeImmutableMedia } from './published-media-probe.js';
import type { PublishedMediaService, SourcePublicationInput } from './published-media-service.js';
import type { PublishedMediaSource } from './published-media-source.js';
import { retainPublishedVideo } from './published-video-stream.js';
import { ContentOwnerConflictError, type ProjectContentOwnerService } from './service.js';
import { digestBytes } from './store.js';
import type { ContentPublicationScopeV1, ContentSourcePublicationV1 } from './types.js';

interface PublicationDependencies {
  owner: ProjectContentOwnerService;
  access: PublishedMediaAccess;
  sources: PublishedMediaSource;
}
type RememberMedia = (digest: string, media: ReviewedMediaAsset['media']) => void;

export async function preparePublishedSource(
  deps: PublicationDependencies,
  media: PublishedMediaService,
  remember: RememberMedia,
  input: SourcePublicationInput,
): Promise<ReviewedMediaAsset> {
  if (
    typeof input.operationId !== 'string' ||
    !input.operationId ||
    input.operationId.length > 256 ||
    input.operationId.trim() !== input.operationId ||
    input.operationId.includes('\0')
  )
    throw new MediaOwnerError('invalid_media');
  if (input.source.kind === 'message') {
    const landing = await findMessagePublicationLanding(deps, media, {
      source: input.source,
      principal: input.principal,
    });
    if (landing?.status === 'resolved') return landing.asset;
    if (landing) throw new MessagePublicationChoiceRequired(landing);
  }
  const existing = await media.findPreparedSource(input);
  if (existing) return existing;
  const source = await deps.sources.resolveSource(input.source, input.operationId, input.principal);
  if ('openVideo' in source && source.openVideo) {
    const retained = await retainPublishedVideo(deps, {
      ...input,
      scope: source.scope,
      publication: source.publication,
      opened: await source.openVideo(),
    });
    remember(retained.blobDigest, retained.media);
    return media.read(retained.contentRef, 1, input.principal);
  }
  const loaded = await source.load();
  return importPreparedPublication(
    deps,
    media,
    remember,
    source.scope,
    { ...loaded, publication: source.publication },
    input,
    () => deps.access.authorizeScope(source.scope, input.principal),
  );
}

export async function importPreparedPublication(
  deps: PublicationDependencies,
  mediaService: PublishedMediaService,
  remember: RememberMedia,
  scope: ContentPublicationScopeV1,
  source: { bytes: Buffer; mediaType: ReviewedMediaAsset['mediaType']; publication: ContentSourcePublicationV1 },
  input: { operationId: string; principal: MediaReviewPrincipal },
  revalidate: () => Promise<unknown>,
): Promise<ReviewedMediaAsset> {
  const media = await probeImmutableMedia(source.bytes, source.mediaType);
  const contentRef = publishedMediaContentRef(scope, source.publication);
  await revalidate();
  await deps.sources.assertVisible(scope, source.publication, input.principal);
  try {
    await deps.owner.importContent({
      contentRef,
      bytes: source.bytes,
      mediaType: source.mediaType,
      actor: input.principal.actor,
      operationId: input.operationId,
      publicationScope: scope,
      sourcePublication: source.publication,
    });
  } catch (error) {
    if (!(error instanceof ContentOwnerConflictError)) throw error;
    const original = await deps.owner.describe(contentRef, 1);
    if (original.blobDigest !== digestBytes(source.bytes) || !samePublicationScope(original.publicationScope, scope)) {
      throw new MediaOwnerError('publication_changed');
    }
  }
  remember(digestBytes(source.bytes), media);
  return mediaService.read(contentRef, 1, input.principal);
}
