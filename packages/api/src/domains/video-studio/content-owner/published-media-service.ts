import { type MediaPublicationSource, type ReviewedMediaAsset, reviewedMediaAssetSchema } from '@cat-cafe/shared';
import { MediaOwnerError } from './media-errors.js';
import { findMessagePublicationLanding, MessagePublicationChoiceRequired } from './message-publication-landing.js';
import { publishedMediaContentRef, samePublicationScope } from './publication.js';
import { type MediaReviewPrincipal, PublishedMediaAccess, withContentTask } from './published-media-access.js';
import { probeImmutableMedia } from './published-media-probe.js';
import type { PublishedMediaSource } from './published-media-source.js';
import { ContentOwnerConflictError, ContentOwnerNotFoundError, type ProjectContentOwnerService } from './service.js';
import { digestBytes } from './store.js';
import { type ContentPublicationScopeV1, type ContentSourcePublicationV1, isTaskPublicationScope } from './types.js';

interface PublicationInput {
  taskId: string;
  expectedTaskRevision: number;
  artifactRef: string;
  expectedArtifactRevision: string;
  operationId: string;
  principal: MediaReviewPrincipal;
}

interface SourcePublicationInput {
  source: MediaPublicationSource;
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

  async prepare(input: PublicationInput | SourcePublicationInput): Promise<ReviewedMediaAsset> {
    if ('source' in input) {
      if (
        typeof input.operationId !== 'string' ||
        !input.operationId ||
        input.operationId.length > 256 ||
        input.operationId.trim() !== input.operationId ||
        input.operationId.includes('\0')
      )
        throw new MediaOwnerError('invalid_media');
      if (input.source.kind === 'message') {
        const landing = await findMessagePublicationLanding(this.deps, this, {
          source: input.source,
          principal: input.principal,
        });
        if (landing?.status === 'resolved') return landing.asset;
        if (landing) throw new MessagePublicationChoiceRequired(landing);
      }
      const existing = await this.findPreparedSource(input);
      if (existing) return existing;
      const source = await this.deps.sources.resolveSource(input.source, input.operationId, input.principal);
      const loaded = await source.load();
      return this.importPublication(source.scope, { ...loaded, publication: source.publication }, input, () =>
        this.access.authorizeScope(source.scope, input.principal),
      );
    }
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
    return this.importPublication(scope, source, input, () =>
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

  private async importPublication(
    scope: ContentPublicationScopeV1,
    source: { bytes: Buffer; mediaType: 'image/png' | 'video/mp4'; publication: ContentSourcePublicationV1 },
    input: { operationId: string; principal: MediaReviewPrincipal },
    revalidate: () => Promise<unknown>,
  ): Promise<ReviewedMediaAsset> {
    const media = await probeImmutableMedia(source.bytes, source.mediaType);
    const contentRef = publishedMediaContentRef(scope, source.publication);
    await revalidate();
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
    input = { ...input, principal: withContentTask(input.principal, input.taskId) };
    const current = await this.deps.owner.describe(input.contentRef);
    await this.access.authorizeScope(current.publicationScope, input.principal, false, input.contentRef);
    const task = await this.access.authorize(input.taskId, input.principal, {
      expectedRevision: input.expectedTaskRevision,
    });
    if (input.principal.actor.kind !== 'cat' || task.ownerCatId !== input.principal.actor.actorId)
      throw new MediaOwnerError('access_denied');
    const scope = current.publicationScope;
    if (!scope) throw new MediaOwnerError('access_denied');
    if (isTaskPublicationScope(scope) && scope.taskId !== task.id) throw new MediaOwnerError('task_changed');
    if (!isTaskPublicationScope(scope))
      await this.access.authorizePublicationTask(input.contentRef, input.principal, false);
    const source = await this.deps.sources.read({
      scope: { ownerUserId: scope.ownerUserId, threadId: task.threadId, taskId: task.id },
      principal: input.principal,
      taskRevision: input.expectedTaskRevision,
      artifactRef: input.artifactRef,
      expectedArtifactRevision: input.expectedArtifactRevision,
    });
    if (source.mediaType !== current.mediaType) throw new MediaOwnerError('invalid_media');
    const media = await probeImmutableMedia(source.bytes, source.mediaType);
    const publication = {
      ...source.publication,
      ...(task.threadId !== scope.threadId ? { threadId: task.threadId } : {}),
    };
    await this.access.authorize(input.taskId, input.principal, { expectedRevision: input.expectedTaskRevision });
    await this.deps.sources.assertVisible(scope, publication, input.principal);
    const receipt = await this.deps.owner.settle({
      contentRef: input.contentRef,
      expectedOwnerRevision: input.expectedOwnerRevision,
      bytes: source.bytes,
      actor: input.principal.actor,
      operationId: input.operationId,
      sourcePublication: publication,
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
      sourcePublication: publication,
      ownerReceiptRef: receipt.receiptId,
    });
  }

  async read(contentRef: string, ownerRevision: number, principal: MediaReviewPrincipal): Promise<ReviewedMediaAsset> {
    const description = await this.deps.owner.describe(contentRef, ownerRevision);
    await this.access.authorizeScope(description.publicationScope, principal, true, contentRef);
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

  async openAsset(asset: ReviewedMediaAsset, principal: MediaReviewPrincipal) {
    const actual = await this.deps.owner.describe(asset.contentRef, asset.ownerRevision);
    if (!actual.publicationScope) throw new MediaOwnerError('access_denied');
    return this.open(asset, actual.publicationScope, principal);
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
