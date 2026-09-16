import { createHash } from 'node:crypto';
import { type ReviewedMediaAsset, reviewedMediaAssetSchema } from '@cat-cafe/shared';
import { MediaOwnerError } from './media-errors.js';
import { samePublicationScope } from './publication.js';
import { type MediaReviewPrincipal, PublishedMediaAccess } from './published-media-access.js';
import { probeImmutableMedia } from './published-media-probe.js';
import type { PublishedMediaSource } from './published-media-source.js';
import { ContentOwnerConflictError, ContentOwnerNotFoundError, type ProjectContentOwnerService } from './service.js';
import { digestBytes } from './store.js';
import type { ContentPublicationScopeV1 } from './types.js';

interface PublicationInput {
  taskId: string;
  expectedTaskRevision: number;
  artifactRef: string;
  expectedArtifactRevision: string;
  operationId: string;
  principal: MediaReviewPrincipal;
}

/** Explicit immutable publication admission. Transport uploads remain sources; F138 owns every retained version. */
export class PublishedMediaService {
  readonly access: PublishedMediaAccess;
  private readonly metadata = new Map<string, ReviewedMediaAsset['media']>();
  constructor(
    private readonly deps: {
      owner: ProjectContentOwnerService;
      access: PublishedMediaAccess;
      sources: PublishedMediaSource;
    },
  ) {
    this.access = deps.access;
  }

  async prepare(input: PublicationInput): Promise<ReviewedMediaAsset> {
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
    const media = await probeImmutableMedia(source.bytes, source.mediaType);
    const contentRef = `prepared-media:${createHash('sha256')
      .update(JSON.stringify([scope, source.publication]))
      .digest('hex')}`;
    await this.access.authorize(task.id, input.principal, { expectedRevision: input.expectedTaskRevision });
    await this.deps.sources.assertVisible(scope, source.publication, input.principal);
    try {
      await this.deps.owner.importContent({
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
      const original = await this.deps.owner.describe(contentRef, 1);
      if (
        original.blobDigest !== digestBytes(source.bytes) ||
        !samePublicationScope(original.publicationScope, scope)
      ) {
        throw new MediaOwnerError('publication_changed');
      }
    }
    this.remember(digestBytes(source.bytes), media);
    return this.read(contentRef, 1, input.principal);
  }

  async publishVersion(
    input: PublicationInput & { contentRef: string; expectedOwnerRevision: number },
  ): Promise<ReviewedMediaAsset> {
    const current = await this.deps.owner.describe(input.contentRef);
    const task = await this.access.authorizeScope(current.publicationScope, input.principal, false);
    if (task.id !== input.taskId || task.entrustedWork?.revision !== input.expectedTaskRevision)
      throw new MediaOwnerError('task_changed');
    if (input.principal.actor.kind !== 'cat' || task.ownerCatId !== input.principal.actor.actorId)
      throw new MediaOwnerError('access_denied');
    const scope = current.publicationScope;
    if (!scope) throw new MediaOwnerError('access_denied');
    const source = await this.deps.sources.read({
      scope,
      principal: input.principal,
      taskRevision: input.expectedTaskRevision,
      artifactRef: input.artifactRef,
      expectedArtifactRevision: input.expectedArtifactRevision,
    });
    if (source.mediaType !== current.mediaType) throw new MediaOwnerError('invalid_media');
    const media = await probeImmutableMedia(source.bytes, source.mediaType);
    await this.access.authorize(input.taskId, input.principal, { expectedRevision: input.expectedTaskRevision });
    await this.deps.sources.assertVisible(scope, source.publication, input.principal);
    const receipt = await this.deps.owner.settle({
      contentRef: input.contentRef,
      expectedOwnerRevision: input.expectedOwnerRevision,
      bytes: source.bytes,
      actor: input.principal.actor,
      operationId: input.operationId,
      sourcePublication: source.publication,
    });
    this.remember(receipt.blobDigest, media);
    // Return the actual owner effect to its projection coordinator even if authority changes afterwards.
    // Every external read/response still goes through the service's fresh authorization fence.
    return reviewedMediaAssetSchema.parse({
      contentRef: input.contentRef,
      ownerRevision: receipt.ownerRevision,
      blobDigest: receipt.blobDigest,
      mediaType: source.mediaType,
      media,
      sourcePublication: source.publication,
      ownerReceiptRef: receipt.receiptId,
    });
  }

  async read(contentRef: string, ownerRevision: number, principal: MediaReviewPrincipal): Promise<ReviewedMediaAsset> {
    const description = await this.deps.owner.describe(contentRef, ownerRevision);
    const task = await this.access.authorizeScope(description.publicationScope, principal);
    if (!description.sourcePublication || !description.publicationScope) throw new MediaOwnerError('access_denied');
    await this.deps.sources.assertVisible(description.publicationScope, description.sourcePublication, principal);
    if (description.mediaType !== 'image/png' && description.mediaType !== 'video/mp4')
      throw new MediaOwnerError('invalid_media');
    let media = this.metadata.get(description.blobDigest);
    if (!media) {
      const loaded = await this.deps.owner.load(contentRef, ownerRevision);
      media = await probeImmutableMedia(loaded.bytes, description.mediaType);
      this.remember(description.blobDigest, media);
    }
    const receipt = (await this.deps.owner.listOutbox(contentRef)).find((item) => item.ownerRevision === ownerRevision);
    if (!receipt || receipt.blobDigest !== description.blobDigest) throw new MediaOwnerError('media_unavailable');
    await this.access.authorize(task.id, principal, { allowClosed: true });
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

  async assertVisible(
    asset: ReviewedMediaAsset,
    scope: ContentPublicationScopeV1,
    principal: MediaReviewPrincipal,
  ): Promise<void> {
    await this.access.authorizeScope(scope, principal);
    const actual = await this.deps.owner.describe(asset.contentRef, asset.ownerRevision);
    if (actual.blobDigest !== asset.blobDigest || !samePublicationScope(actual.publicationScope, scope))
      throw new MediaOwnerError('access_denied');
    await this.deps.sources.assertVisible(scope, asset.sourcePublication, principal);
  }

  async bytes(contentRef: string, ownerRevision: number, principal: MediaReviewPrincipal): Promise<Buffer> {
    await this.read(contentRef, ownerRevision, principal);
    const content = await this.deps.owner.load(contentRef, ownerRevision);
    await this.access.authorizeScope(content.publicationScope, principal);
    if (!content.publicationScope || !content.sourcePublication) throw new MediaOwnerError('access_denied');
    await this.deps.sources.assertVisible(content.publicationScope, content.sourcePublication, principal);
    return content.bytes;
  }

  async open(asset: ReviewedMediaAsset, scope: ContentPublicationScopeV1, principal: MediaReviewPrincipal) {
    await this.assertVisible(asset, scope, principal);
    const content = await this.deps.owner.open(asset.contentRef, asset.ownerRevision);
    try {
      if (content.blobDigest !== asset.blobDigest || !samePublicationScope(content.publicationScope, scope)) {
        throw new MediaOwnerError('access_denied');
      }
      await this.assertVisible(asset, scope, principal);
      return content;
    } catch (error) {
      await content.handle.close();
      throw error;
    }
  }

  async currentRevision(contentRef: string, principal: MediaReviewPrincipal): Promise<number> {
    const description = await this.deps.owner.describe(contentRef);
    await this.access.authorizeScope(description.publicationScope, principal);
    return description.currentOwnerRevision;
  }

  async operationReceipt(contentRef: string, operationId: string, principal: MediaReviewPrincipal) {
    try {
      const description = await this.deps.owner.describe(contentRef);
      await this.access.authorizeScope(description.publicationScope, principal);
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
