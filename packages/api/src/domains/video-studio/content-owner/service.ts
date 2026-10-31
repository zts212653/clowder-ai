import { CollectiveContentCustody } from './collective-snapshot.js';
import { type ContentCommitInput, commitContentRevision, resolveReplay } from './commit-revision.js';
import { ContentOwnerConflictError, ContentOwnerNotFoundError } from './errors.js';
import {
  type ImportContentStreamInput,
  persistContentStream,
  type SettleContentStreamInput,
} from './stream-service.js';

export { ContentOwnerConflictError, ContentOwnerIdempotencyError, ContentOwnerNotFoundError } from './errors.js';

import {
  collectiveContentScopeRef,
  validateCollectiveContentScope,
  validateCollectiveContentWrite,
} from './collective-scope.js';
import { validateActor, validateIdentity, validateRevision } from './input-validation.js';
import { operationFingerprint } from './operation-identity.js';
import { validateVideoProjectMediaScope } from './project-media-scope.js';
import { validateContentOperationContext, validateVideoProjectScope } from './project-scope.js';
import { validateContentPublication } from './publication.js';
import { digestBytes, ProjectContentOwnerStore } from './store.js';
import type {
  ContentSettlementReceiptV1,
  ImportProjectContentInputV1,
  LoadedProjectContentV1,
  SettleProjectContentInputV1,
} from './types.js';
import { isWorkPublicationScope } from './types.js';

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

  importStream(input: ImportContentStreamInput): Promise<ContentSettlementReceiptV1> {
    return persistContentStream(this.store, this.now, { ...input, kind: 'import' });
  }

  settleStream(input: SettleContentStreamInput): Promise<ContentSettlementReceiptV1> {
    return persistContentStream(this.store, this.now, { ...input, kind: 'settle' });
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
      if (!state.collectiveScope) await input.authorizeEffect?.();
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
        authorizeEffect: input.authorizeEffect,
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

  /** Internal immutable revision facts; consumers still own current access checks. Never reads the payload. */
  async describeRevision(contentRef: string, ownerRevision: number) {
    validateIdentity(contentRef, 'contentRef');
    validateRevision(ownerRevision);
    const state = await this.store.readState(contentRef);
    const revision = state?.revisions.find((item) => item.ownerRevision === ownerRevision);
    if (!revision) throw new ContentOwnerNotFoundError(contentRef);
    return structuredClone(revision);
  }

  /** Internal recovery barrier: receipt absence is meaningful only while queued effects cannot commit. */
  async reconcileWorkOperation<T>(
    input: { contentRef: string; ownerUserId: string; operationId: string },
    consume: (receipt: ContentSettlementReceiptV1 | undefined) => Promise<T>,
  ): Promise<T> {
    validateIdentity(input.contentRef, 'contentRef');
    validateIdentity(input.operationId, 'operationId');
    return this.store.withContentLock(input.contentRef, async () => {
      const state = await this.store.readState(input.contentRef);
      if (!isWorkPublicationScope(state?.publicationScope) || state.publicationScope.ownerUserId !== input.ownerUserId)
        throw new TypeError('Work recovery requires the original owner scope');
      const receipt = state.receipts.find((item) => item.operationId === input.operationId);
      return consume(receipt ? structuredClone(receipt) : undefined);
    });
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

  /** Canonical read projection, never a persisted catalogue or an authorization grant. */
  retainedMediaHeads(ownerUserId: string) {
    validateIdentity(ownerUserId, 'ownerUserId');
    return this.store.retainedMediaHeads(ownerUserId);
  }

  /** Internal batch lookup; read projections must freshly authorize each resulting coordinate. */
  findSourcePublicationsBatch(input: Parameters<ProjectContentOwnerStore['findSourcePublicationsBatch']>[0]) {
    return this.store.findSourcePublicationsBatch(input);
  }

  private commit(input: ContentCommitInput): Promise<ContentSettlementReceiptV1> {
    return commitContentRevision(this.store, this.now, input);
  }
}
