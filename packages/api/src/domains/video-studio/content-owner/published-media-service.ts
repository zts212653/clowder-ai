import {
  type ArtifactReviewAnchor,
  type MediaPublicationSource,
  type ReviewedMediaAsset,
  reviewedMediaAssetSchema,
  reviewedMediaTypeSchema,
} from '@cat-cafe/shared';
import { MediaOwnerError } from './media-errors.js';
import { findMessagePublicationLanding } from './message-publication-landing.js';
import { publishedMediaContentRef, samePublicationScope } from './publication.js';
import { type PublishedAnchorEvidenceVerifier, verifyPublishedAnchorEvidence } from './published-anchor-evidence.js';
import { type MediaReviewPrincipal, PublishedMediaAccess, withContentTask } from './published-media-access.js';
import { listRetainedPublishedMedia } from './published-media-catalogue.js';
import { importPreparedPublication, preparePublishedSource } from './published-media-preparation.js';
import { probeImmutableMedia, probeImmutableVideoFile } from './published-media-probe.js';
import type { PublishedMediaSource } from './published-media-source.js';
import { type PublishedMediaVersionInput, publishMediaVersion } from './published-media-version.js';
import { ContentOwnerNotFoundError, type ProjectContentOwnerService } from './service.js';
import { type ContentPublicationScopeV1, isTaskPublicationScope } from './types.js';

interface PublicationInput {
  taskId: string;
  expectedTaskRevision: number;
  artifactRef: string;
  expectedArtifactRevision: string;
  operationId: string;
  principal: MediaReviewPrincipal;
}

export interface SourcePublicationInput {
  source: MediaPublicationSource;
  operationId: string;
  principal: MediaReviewPrincipal;
}

/** Explicit immutable publication admission. Transport uploads remain sources; F138 owns every retained version. */
export class PublishedMediaService {
  readonly access: PublishedMediaAccess;
  private readonly metadata = new Map<string, ReviewedMediaAsset['media']>();
  private anchorEvidenceVerifier?: PublishedAnchorEvidenceVerifier;

  /** F309 owns retained paragraph metadata; the media owner only fences its exact-version admission. */
  setAnchorEvidenceVerifier(verifier: PublishedAnchorEvidenceVerifier) {
    this.anchorEvidenceVerifier = verifier;
  }

  async assertAnchorEvidence(
    reference: { contentRef: string; ownerRevision: number },
    anchor: ArtifactReviewAnchor,
    principal: MediaReviewPrincipal,
  ) {
    return verifyPublishedAnchorEvidence(this, reference, anchor, principal, this.anchorEvidenceVerifier);
  }
  constructor(
    private readonly deps: {
      owner: ProjectContentOwnerService;
      access: PublishedMediaAccess;
      sources: PublishedMediaSource;
    },
  ) {
    this.access = deps.access;
  }

  async prepare(input: PublicationInput | SourcePublicationInput): Promise<ReviewedMediaAsset> {
    if ('source' in input) return preparePublishedSource(this.deps, this, this.remember.bind(this), input);
    const task = await this.access.authorize(input.taskId, input.principal, {
      expectedRevision: input.expectedTaskRevision,
    });
    if (!task.entrustedWork?.artifactRefs.includes(input.artifactRef)) throw new MediaOwnerError('publication_changed');
    const scope = { ownerUserId: input.principal.userId, taskId: task.id, threadId: task.threadId };
    const source = await this.deps.sources.read({
      scope,
      principal: input.principal,
      taskRevision: input.expectedTaskRevision,
      artifactRef: input.artifactRef,
      expectedArtifactRevision: input.expectedArtifactRevision,
    });
    return importPreparedPublication(this.deps, this, this.remember.bind(this), scope, source, input, () =>
      this.access.authorize(task.id, input.principal, {
        expectedRevision: input.expectedTaskRevision,
      }),
    );
  }

  async resolveMessage(input: {
    source: import('@cat-cafe/shared').MessageMediaPublicationSource;
    operationId: string;
    principal: MediaReviewPrincipal;
    selection?: { contentRef: string; ownerRevision: number };
  }): Promise<import('@cat-cafe/shared').MessagePublicationLanding> {
    const existing = await findMessagePublicationLanding(this.deps, this, input);
    return existing ?? { status: 'resolved', ownerUserId: input.principal.userId, asset: await this.prepare(input) };
  }

  /** Locate only this source operation's retained owner object; never infer a prior write from equal bytes. */
  async findPreparedSource(input: SourcePublicationInput): Promise<ReviewedMediaAsset | null> {
    await this.access.authorizeThread(input.source.threadId, input.principal);
    const source = await this.deps.sources.resolveSource(input.source, input.operationId, input.principal);
    const contentRef = publishedMediaContentRef(source.scope, source.publication);
    try {
      const existing = await this.deps.owner.describe(contentRef, 1);
      if (!samePublicationScope(existing.publicationScope, source.scope))
        throw new MediaOwnerError('publication_changed');
      return this.read(contentRef, 1, input.principal);
    } catch (error) {
      if (error instanceof ContentOwnerNotFoundError) return null;
      throw error;
    }
  }

  async publishVersion(input: PublishedMediaVersionInput): Promise<ReviewedMediaAsset> {
    const asset = await publishMediaVersion(this.deps, input);
    this.remember(asset.blobDigest, asset.media);
    return asset;
  }

  async read(contentRef: string, ownerRevision: number, principal: MediaReviewPrincipal): Promise<ReviewedMediaAsset> {
    const description = await this.deps.owner.describe(contentRef, ownerRevision);
    await this.access.authorizeScope(description.publicationScope, principal, true, contentRef);
    if (!description.sourcePublication || !description.publicationScope) throw new MediaOwnerError('access_denied');
    await this.deps.sources.assertVisible(description.publicationScope, description.sourcePublication, principal);
    const mime = reviewedMediaTypeSchema.safeParse(description.mediaType);
    if (!mime.success) throw new MediaOwnerError('invalid_media');
    let media = this.metadata.get(description.blobDigest);
    if (!media) {
      if (mime.data === 'video/mp4') {
        const opened = await this.deps.owner.open(contentRef, ownerRevision);
        try {
          media = await probeImmutableVideoFile(opened.path);
        } finally {
          await opened.handle.close();
        }
      } else {
        const loaded = await this.deps.owner.load(contentRef, ownerRevision);
        media = await probeImmutableMedia(loaded.bytes, mime.data);
      }
      this.remember(description.blobDigest, media);
    }
    const receipt = (await this.deps.owner.listOutbox(contentRef)).find((item) => item.ownerRevision === ownerRevision);
    if (!receipt || receipt.blobDigest !== description.blobDigest) throw new MediaOwnerError('media_unavailable');
    await this.access.authorizeScope(description.publicationScope, principal, true, contentRef);
    await this.deps.sources.assertVisible(description.publicationScope, description.sourcePublication, principal);
    return reviewedMediaAssetSchema.parse({
      contentRef,
      ownerRevision,
      blobDigest: description.blobDigest,
      mediaType: description.mediaType,
      media,
      sourcePublication: description.sourcePublication,
      ownerReceiptRef: receipt.receiptId,
    });
  }

  /** Local Human picker; every discovered version is reauthorized. */
  listRetained(principal: MediaReviewPrincipal, after?: string) {
    return listRetainedPublishedMedia(this.deps.owner, this, principal, after);
  }

  async describe(contentRef: string, ownerRevision: number | undefined, principal: MediaReviewPrincipal) {
    const currentOwnerRevision = await this.currentRevision(contentRef, principal);
    const asset = await this.read(contentRef, ownerRevision ?? currentOwnerRevision, principal);
    const { scope } = await this.origin(contentRef, principal);
    const origin = await this.deps.sources.originDetails(scope, principal);
    return { asset, currentOwnerRevision, origin };
  }

  async assertVisible(
    asset: ReviewedMediaAsset,
    scope: ContentPublicationScopeV1,
    principal: MediaReviewPrincipal,
  ): Promise<void> {
    await this.access.authorizeScope(scope, principal, true, asset.contentRef);
    const actual = await this.deps.owner.describe(asset.contentRef, asset.ownerRevision);
    if (actual.blobDigest !== asset.blobDigest || !samePublicationScope(actual.publicationScope, scope))
      throw new MediaOwnerError('access_denied');
    await this.deps.sources.assertVisible(scope, asset.sourcePublication, principal);
  }

  /** Task custody references a publication without replacing its original source authority. */
  async assertTaskAsset(
    asset: ReviewedMediaAsset,
    taskScope: { ownerUserId: string; threadId: string; taskId: string },
    principal: MediaReviewPrincipal,
  ): Promise<void> {
    principal = withContentTask(principal, taskScope.taskId);
    const task = await this.access.authorizeScope(taskScope, principal);
    const actual = await this.deps.owner.describe(asset.contentRef, asset.ownerRevision);
    const scope = actual.publicationScope;
    if (
      !scope ||
      scope.ownerUserId !== taskScope.ownerUserId ||
      (isTaskPublicationScope(scope) && (scope.taskId !== taskScope.taskId || scope.threadId !== taskScope.threadId)) ||
      (!isTaskPublicationScope(scope) && !task.entrustedWork)
    )
      throw new MediaOwnerError('access_denied');
    if (!isTaskPublicationScope(scope) && principal.actor.kind === 'cat')
      await this.access.authorizePublicationTask(asset.contentRef, principal);
    await this.assertVisible(asset, scope, principal);
  }

  async openAsset(asset: ReviewedMediaAsset, principal: MediaReviewPrincipal, localFile = false) {
    const actual = await this.deps.owner.describe(asset.contentRef, asset.ownerRevision);
    if (!actual.publicationScope) throw new MediaOwnerError('access_denied');
    return this.open(asset, actual.publicationScope, principal, localFile);
  }

  async origin(contentRef: string, principal: MediaReviewPrincipal) {
    const description = await this.deps.owner.describe(contentRef, 1);
    const scope = description.publicationScope,
      publication = description.sourcePublication;
    if (!scope || !publication) throw new MediaOwnerError('access_denied');
    await this.access.authorizeScope(scope, principal, true, contentRef);
    await this.deps.sources.assertVisible(scope, publication, principal);
    return { scope, publication };
  }

  async bytes(contentRef: string, ownerRevision: number, principal: MediaReviewPrincipal): Promise<Buffer> {
    await this.read(contentRef, ownerRevision, principal);
    const content = await this.deps.owner.load(contentRef, ownerRevision);
    await this.access.authorizeScope(content.publicationScope, principal, true, contentRef);
    if (!content.publicationScope || !content.sourcePublication) throw new MediaOwnerError('access_denied');
    await this.deps.sources.assertVisible(content.publicationScope, content.sourcePublication, principal);
    return content.bytes;
  }

  async open(
    asset: ReviewedMediaAsset,
    scope: ContentPublicationScopeV1,
    principal: MediaReviewPrincipal,
    localFile = false,
  ) {
    await this.assertVisible(asset, scope, principal);
    const content = await this.deps.owner.open(asset.contentRef, asset.ownerRevision);
    try {
      if (content.blobDigest !== asset.blobDigest || !samePublicationScope(content.publicationScope, scope)) {
        throw new MediaOwnerError('access_denied');
      }
      await this.assertVisible(asset, scope, principal);
      const originalPath = localFile
        ? await this.deps.sources.localOriginalFile(content.sourcePublication, content.blobDigest)
        : null;
      const publication =
        localFile && 'kind' in scope && scope.kind === 'message'
          ? await this.deps.sources.messageIdentity(scope.source, principal)
          : null;
      if (localFile) await this.assertVisible(asset, scope, principal);
      return {
        ...content,
        path: originalPath ?? content.path,
        fileAuthor:
          publication?.publisherCatId ??
          (content.committedBy?.kind === 'cat' ? content.committedBy.actorId : undefined),
        fileCreatedAt:
          publication && 'kind' in scope && scope.kind === 'message'
            ? new Date(Number(scope.source.messageRevision)).toISOString()
            : content.committedAt,
      };
    } catch (error) {
      await content.handle.close();
      throw error;
    }
  }

  async currentRevision(contentRef: string, principal: MediaReviewPrincipal): Promise<number> {
    const description = await this.deps.owner.describe(contentRef);
    await this.access.authorizeScope(description.publicationScope, principal, true, contentRef);
    if (description.publicationScope && !isTaskPublicationScope(description.publicationScope)) {
      if (!description.sourcePublication) throw new MediaOwnerError('access_denied');
      await this.deps.sources.assertVisible(description.publicationScope, description.sourcePublication, principal);
    }
    return description.currentOwnerRevision;
  }

  async operationReceipt(contentRef: string, operationId: string, principal: MediaReviewPrincipal) {
    try {
      const description = await this.deps.owner.describe(contentRef);
      await this.access.authorizeScope(description.publicationScope, principal, true, contentRef);
      if (description.publicationScope && !isTaskPublicationScope(description.publicationScope)) {
        if (!description.sourcePublication) throw new MediaOwnerError('access_denied');
        await this.deps.sources.assertVisible(description.publicationScope, description.sourcePublication, principal);
      }
      return (
        (await this.deps.owner.listOutbox(contentRef)).find((receipt) => receipt.operationId === operationId) ?? null
      );
    } catch (error) {
      if (error instanceof ContentOwnerNotFoundError) return null;
      throw error;
    }
  }

  private remember(digest: string, media: ReviewedMediaAsset['media']): void {
    if (this.metadata.size >= 64) {
      const oldest = this.metadata.keys().next().value;
      if (oldest) this.metadata.delete(oldest);
    }
    this.metadata.set(digest, media);
  }
}
