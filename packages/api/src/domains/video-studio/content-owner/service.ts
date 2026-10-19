import { CollectiveContentCustody } from './collective-snapshot.js';
import { ContentOwnerConflictError, ContentOwnerIdempotencyError, ContentOwnerNotFoundError } from './errors.js';

export { ContentOwnerConflictError, ContentOwnerIdempotencyError, ContentOwnerNotFoundError } from './errors.js';

import {
  type CollectiveContentScopeV1,
  collectiveContentScopeRef,
  requireCollectiveContentCapacity,
  validateCollectiveContentScope,
  validateCollectiveContentWrite,
} from './collective-scope.js';
import { validateActor, validateIdentity, validateRevision } from './input-validation.js';
import { createReceiptId, operationFingerprint } from './operation-identity.js';
import { validateVideoProjectMediaScope } from './project-media-scope.js';
import { validateContentOperationContext, validateVideoProjectScope } from './project-scope.js';
import { validateContentPublication } from './publication.js';
import { digestBytes, ProjectContentOwnerStore, type ProjectContentStateV1 } from './store.js';
import type {
  ContentActorV1,
  ContentOperationContextV1,
  ContentPublicationScopeV1,
  ContentSettlementReceiptV1,
  ContentSourcePublicationV1,
  ImportProjectContentInputV1,
  LoadedProjectContentV1,
  ProjectContentRevisionV1,
  SettleProjectContentInputV1,
  VideoProjectMediaScopeV1,
  VideoProjectScopeV1,
} from './types.js';

export interface ProjectContentOwnerServiceOptions {
  readonly dataDir: string;
  readonly now?: () => string;
}

export class ProjectContentOwnerService {
  readonly collectiveCustody: CollectiveContentCustody;
  private readonly store: ProjectContentOwnerStore;
  private readonly now: () => string;

  constructor(options: ProjectContentOwnerServiceOptions) {
    this.store = new ProjectContentOwnerStore(options.dataDir);
    this.collectiveCustody = new CollectiveContentCustody(this.store);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async importContent(input: ImportProjectContentInputV1): Promise<ContentSettlementReceiptV1> {
    validateIdentity(input.contentRef, 'contentRef');
    validateIdentity(input.operationId, 'operationId');
    validateIdentity(input.mediaType, 'mediaType');
    validateActor(input.actor);
    validateContentPublication(input.publicationScope, input.sourcePublication);
    validateVideoProjectScope(input.projectScope, input.contentRef, input.mediaType, input.publicationScope);
    validateCollectiveContentScope(input.collectiveScope, input);
    validateContentOperationContext(input.operationContext, input.projectScope, input.collectiveScope);
    validateVideoProjectMediaScope(input.projectMediaScope, input);
    const bytes = Buffer.from(input.bytes);
    validateCollectiveContentWrite({
      scope: input.collectiveScope,
      context: input.operationContext,
      actor: input.actor,
      kind: 'collective-artifact:publish',
      bytes,
      authorizeEffect: input.authorizeEffect,
    });
    const blobDigest = digestBytes(bytes);
    const fingerprint = operationFingerprint({
      contentRef: input.contentRef,
      expectedOwnerRevision: 0,
      blobDigest,
      mediaType: input.mediaType,
      actor: input.actor,
      publicationScope: input.publicationScope,
      projectScope: input.projectScope,
      projectMediaScope: input.projectMediaScope,
      operationContext: input.operationContext,
      sourcePublication: input.sourcePublication,
      collectiveScope: input.collectiveScope,
    });

    return this.store.withContentLock(input.contentRef, async () => {
      await this.store.collectiveFence.authorizeEffect(
        input.contentRef,
        input.collectiveScope,
        input.operationContext,
        input.authorizeEffect,
      );
      const state = await this.store.readState(input.contentRef);
      const replay = resolveReplay(state, input.operationId, fingerprint);
      if (replay) return replay;
      if (state) throw new ContentOwnerConflictError(input.contentRef, 0, state.currentOwnerRevision);
      return this.commit({
        contentRef: input.contentRef,
        previousState: undefined,
        mediaType: input.mediaType,
        bytes,
        blobDigest,
        operationId: input.operationId,
        fingerprint,
        actor: input.actor,
        publicationScope: input.publicationScope,
        projectScope: input.projectScope,
        projectMediaScope: input.projectMediaScope,
        operationContext: input.operationContext,
        sourcePublication: input.sourcePublication,
        collectiveScope: input.collectiveScope,
        authorizeEffect: input.collectiveScope ? input.authorizeEffect : undefined,
      });
    });
  }

  async settle(input: SettleProjectContentInputV1): Promise<ContentSettlementReceiptV1> {
    validateIdentity(input.contentRef, 'contentRef');
    validateIdentity(input.operationId, 'operationId');
    validateRevision(input.expectedOwnerRevision);
    validateActor(input.actor);
    if ('projectMediaScope' in input) throw new TypeError('Project media scope cannot change');
    if ('projectScope' in input) throw new TypeError('Project scope cannot change during settlement');
    if ('collectiveScope' in input) throw new TypeError('Collective scope cannot change during settlement');
    const bytes = Buffer.from(input.bytes);
    const blobDigest = digestBytes(bytes);

    return this.store.withContentLock(input.contentRef, async () => {
      const state = await this.store.readState(input.contentRef);
      if (!state) throw new ContentOwnerNotFoundError(input.contentRef);
      if (state.projectMediaScope) throw new TypeError('Project screening media is immutable');
      validateContentPublication(state.publicationScope, input.sourcePublication);
      validateContentOperationContext(input.operationContext, state.projectScope, state.collectiveScope);
      validateCollectiveContentWrite({
        scope: state.collectiveScope,
        context: input.operationContext,
        actor: input.actor,
        kind: 'collective-artifact:apply',
        bytes,
        authorizeEffect: input.authorizeEffect,
      });
      await this.store.collectiveFence.authorizeEffect(
        input.contentRef,
        state.collectiveScope,
        input.operationContext,
        input.authorizeEffect,
      );
      const fingerprint = operationFingerprint({
        contentRef: input.contentRef,
        expectedOwnerRevision: input.expectedOwnerRevision,
        blobDigest,
        mediaType: state.mediaType,
        actor: input.actor,
        publicationScope: state.publicationScope,
        projectScope: state.projectScope,
        operationContext: input.operationContext,
        sourcePublication: input.sourcePublication,
        collectiveScope: state.collectiveScope,
      });
      const replay = resolveReplay(state, input.operationId, fingerprint);
      if (replay) return replay;
      if (state.currentOwnerRevision !== input.expectedOwnerRevision) {
        throw new ContentOwnerConflictError(input.contentRef, input.expectedOwnerRevision, state.currentOwnerRevision);
      }
      return this.commit({
        contentRef: input.contentRef,
        previousState: state,
        mediaType: state.mediaType,
        bytes,
        blobDigest,
        operationId: input.operationId,
        fingerprint,
        actor: input.actor,
        publicationScope: state.publicationScope,
        projectScope: state.projectScope,
        operationContext: input.operationContext,
        sourcePublication: input.sourcePublication,
        collectiveScope: state.collectiveScope,
        authorizeEffect: state.collectiveScope ? input.authorizeEffect : undefined,
      });
    });
  }

  async load(contentRef: string, ownerRevision?: number): Promise<LoadedProjectContentV1> {
    const metadata = await this.describe(contentRef, ownerRevision);
    return { ...metadata, bytes: await this.store.readBlob(contentRef, metadata.blobDigest) };
  }

  async open(contentRef: string, ownerRevision: number) {
    const metadata = await this.describe(contentRef, ownerRevision);
    const state = await this.store.readState(contentRef);
    const revision = state?.revisions.find((item) => item.ownerRevision === ownerRevision);
    return {
      ...metadata,
      ...(await this.store.openBlob(contentRef, metadata.blobDigest)),
      committedBy: revision?.committedBy,
      committedAt: revision?.committedAt,
    };
  }

  async describe(contentRef: string, ownerRevision?: number): Promise<Omit<LoadedProjectContentV1, 'bytes'>> {
    validateIdentity(contentRef, 'contentRef');
    if (ownerRevision !== undefined) {
      validateRevision(ownerRevision);
      if (ownerRevision === 0) throw new TypeError('ownerRevision must be positive');
    }
    const state = await this.store.readState(contentRef);
    if (!state) throw new ContentOwnerNotFoundError(contentRef);
    const current = state.revisions.find(
      (revision) => revision.ownerRevision === (ownerRevision ?? state.currentOwnerRevision),
    );
    if (!current) throw new ContentOwnerNotFoundError(contentRef);
    return {
      contentRef,
      ownerRevision: current.ownerRevision,
      blobDigest: current.blobDigest,
      byteLength: current.byteLength,
      mediaType: current.mediaType,
      currentOwnerRevision: state.currentOwnerRevision,
      ...(state.collectiveScope ? { collectiveScope: structuredClone(state.collectiveScope) } : {}),
      ...(state.publicationScope ? { publicationScope: { ...state.publicationScope } } : {}),
      ...(state.projectScope ? { projectScope: { ...state.projectScope } } : {}),
      ...(state.projectMediaScope ? { projectMediaScope: structuredClone(state.projectMediaScope) } : {}),
      ...(current.sourcePublication ? { sourcePublication: { ...current.sourcePublication } } : {}),
    };
  }

  async listOutbox(contentRef: string): Promise<readonly ContentSettlementReceiptV1[]> {
    validateIdentity(contentRef, 'contentRef');
    const state = await this.store.readState(contentRef);
    if (!state) throw new ContentOwnerNotFoundError(contentRef);
    return state.receipts.map((receipt) => ({ ...receipt, actor: { ...receipt.actor } }));
  }

  /** Internal recovery barrier: receipt absence is meaningful only while queued effects cannot commit. */
  async reconcileCollectiveOperation<T>(
    input: { contentRef: string; scopeRef: string; operationId: string; allowMissingInitialPublication?: boolean },
    consume: (receipt: ContentSettlementReceiptV1 | undefined) => T,
  ): Promise<T> {
    validateIdentity(input.contentRef, 'contentRef');
    validateIdentity(input.operationId, 'operationId');
    return this.store.withContentLock(input.contentRef, async () => {
      const state = await this.store.readState(input.contentRef);
      if (!state && input.allowMissingInitialPublication) return consume(undefined);
      if (!state?.collectiveScope || collectiveContentScopeRef(state.collectiveScope) !== input.scopeRef)
        throw new TypeError('Collective recovery requires the exact canonical scope');
      const receipt = state.receipts.find((item) => item.operationId === input.operationId);
      return consume(receipt ? structuredClone(receipt) : undefined);
    });
  }

  /** Internal owner lookup; callers must reauthorize each resulting publication before exposing it. */
  findSourcePublications(input: Parameters<ProjectContentOwnerStore['findSourcePublications']>[0]) {
    return this.store.findSourcePublications(input);
  }

  /** Primary manifest discovery; the project service must authorize scope before exposing content. */
  listVideoProjects(ownerUserId: string) {
    validateIdentity(ownerUserId, 'ownerUserId');
    return this.store.listVideoProjects(ownerUserId);
  }

  listRetainedMedia(ownerUserId: string, after?: string) {
    validateIdentity(ownerUserId, 'ownerUserId');
    return this.store.listRetainedMedia(ownerUserId, after);
  }

  /** Internal batch lookup; read projections must freshly authorize each resulting coordinate. */
  findSourcePublicationsBatch(input: Parameters<ProjectContentOwnerStore['findSourcePublicationsBatch']>[0]) {
    return this.store.findSourcePublicationsBatch(input);
  }

  private async commit(input: {
    readonly contentRef: string;
    readonly previousState: ProjectContentStateV1 | undefined;
    readonly mediaType: string;
    readonly bytes: Buffer;
    readonly blobDigest: `sha256:${string}`;
    readonly operationId: string;
    readonly fingerprint: `sha256:${string}`;
    readonly actor: ContentActorV1;
    readonly publicationScope: ContentPublicationScopeV1 | undefined;
    readonly projectScope: VideoProjectScopeV1 | undefined;
    readonly projectMediaScope?: VideoProjectMediaScopeV1;
    readonly operationContext: ContentOperationContextV1 | undefined;
    readonly sourcePublication: ContentSourcePublicationV1 | undefined;
    readonly collectiveScope?: CollectiveContentScopeV1;
    readonly authorizeEffect?: () => Promise<void>;
  }): Promise<ContentSettlementReceiptV1> {
    const previousOwnerRevision = input.previousState?.currentOwnerRevision ?? 0;
    const ownerRevision = previousOwnerRevision + 1;
    requireCollectiveContentCapacity(input.collectiveScope, ownerRevision);
    const outboxSequence = (input.previousState?.receipts.length ?? 0) + 1;
    const revision: ProjectContentRevisionV1 = {
      contentRef: input.contentRef,
      ownerRevision,
      blobDigest: input.blobDigest,
      byteLength: input.bytes.byteLength,
      mediaType: input.mediaType,
      parentRevision: previousOwnerRevision === 0 ? null : previousOwnerRevision,
      committedBy: { ...input.actor },
      operationId: input.operationId,
      committedAt: this.now(),
      ...(input.sourcePublication ? { sourcePublication: { ...input.sourcePublication } } : {}),
    };
    const receipt: ContentSettlementReceiptV1 = {
      receiptId: createReceiptId(input.contentRef, input.operationId, ownerRevision, input.blobDigest),
      contentRef: input.contentRef,
      previousOwnerRevision,
      ownerRevision,
      blobDigest: input.blobDigest,
      actor: { ...input.actor },
      operationId: input.operationId,
      outboxSequence,
      ...(input.operationContext ? { operationContext: { ...input.operationContext } } : {}),
    };
    const state: ProjectContentStateV1 = {
      schemaVersion: 1,
      contentRef: input.contentRef,
      mediaType: input.mediaType,
      currentOwnerRevision: ownerRevision,
      revisions: [...(input.previousState?.revisions ?? []), revision],
      receipts: [...(input.previousState?.receipts ?? []), receipt],
      operations: {
        ...(input.previousState?.operations ?? {}),
        [input.operationId]: { fingerprint: input.fingerprint, receiptId: receipt.receiptId },
      },
      ...(input.publicationScope ? { publicationScope: { ...input.publicationScope } } : {}),
      ...(input.projectScope ? { projectScope: { ...input.projectScope } } : {}),
      ...(input.projectMediaScope ? { projectMediaScope: structuredClone(input.projectMediaScope) } : {}),
      ...(input.collectiveScope ? { collectiveScope: structuredClone(input.collectiveScope) } : {}),
    };

    if (!input.previousState && input.collectiveScope && input.authorizeEffect) {
      await this.store.commitInitialState(state, input.bytes, input.authorizeEffect);
    } else {
      await this.store.writeBlob(input.contentRef, input.blobDigest, input.bytes);
      await this.store.writeState(input.contentRef, state, input.authorizeEffect);
    }
    return receipt;
  }
}

function resolveReplay(
  state: ProjectContentStateV1 | undefined,
  operationId: string,
  fingerprint: `sha256:${string}`,
): ContentSettlementReceiptV1 | undefined {
  if (!state || !Object.hasOwn(state.operations, operationId)) return undefined;
  const existing = state.operations[operationId];
  if (!existing) return undefined;
  if (existing.fingerprint !== fingerprint) {
    throw new ContentOwnerIdempotencyError(state.contentRef, operationId);
  }
  const receipt = state.receipts.find((candidate) => candidate.receiptId === existing.receiptId);
  if (!receipt) throw new Error(`Receipt ${existing.receiptId} is missing for operation ${operationId}`);
  return receipt;
}
