import { createHash } from 'node:crypto';
import { validateContentPublication } from './publication.js';
import { digestBytes, ProjectContentOwnerStore, type ProjectContentStateV1 } from './store.js';
import type {
  ContentActorV1,
  ContentPublicationScopeV1,
  ContentSettlementReceiptV1,
  ContentSourcePublicationV1,
  ImportProjectContentInputV1,
  LoadedProjectContentV1,
  ProjectContentRevisionV1,
  SettleProjectContentInputV1,
} from './types.js';

export class ContentOwnerConflictError extends Error {
  readonly code = 'OWNER_REVISION_CONFLICT';

  constructor(
    readonly contentRef: string,
    readonly expectedOwnerRevision: number,
    readonly actualOwnerRevision: number,
  ) {
    super(
      `Content owner revision conflict for ${contentRef}: expected ${expectedOwnerRevision}, actual ${actualOwnerRevision}`,
    );
    this.name = 'ContentOwnerConflictError';
  }
}

export class ContentOwnerIdempotencyError extends Error {
  readonly code = 'OPERATION_ID_REUSED';

  constructor(
    readonly contentRef: string,
    readonly operationId: string,
  ) {
    super(`Operation ${operationId} was reused with different content-owner inputs for ${contentRef}`);
    this.name = 'ContentOwnerIdempotencyError';
  }
}

export class ContentOwnerNotFoundError extends Error {
  readonly code = 'CONTENT_NOT_FOUND';

  constructor(readonly contentRef: string) {
    super(`Content not found: ${contentRef}`);
    this.name = 'ContentOwnerNotFoundError';
  }
}

export interface ProjectContentOwnerServiceOptions {
  readonly dataDir: string;
  readonly now?: () => string;
}

export class ProjectContentOwnerService {
  private readonly store: ProjectContentOwnerStore;
  private readonly now: () => string;

  constructor(options: ProjectContentOwnerServiceOptions) {
    this.store = new ProjectContentOwnerStore(options.dataDir);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async importContent(input: ImportProjectContentInputV1): Promise<ContentSettlementReceiptV1> {
    validateIdentity(input.contentRef, 'contentRef');
    validateIdentity(input.operationId, 'operationId');
    validateIdentity(input.mediaType, 'mediaType');
    validateActor(input.actor);
    validateContentPublication(input.publicationScope, input.sourcePublication);
    const bytes = Buffer.from(input.bytes);
    const blobDigest = digestBytes(bytes);
    const fingerprint = operationFingerprint({
      contentRef: input.contentRef,
      expectedOwnerRevision: 0,
      blobDigest,
      mediaType: input.mediaType,
      actor: input.actor,
      publicationScope: input.publicationScope,
      sourcePublication: input.sourcePublication,
    });

    return this.store.withContentLock(input.contentRef, async () => {
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
        sourcePublication: input.sourcePublication,
      });
    });
  }

  async settle(input: SettleProjectContentInputV1): Promise<ContentSettlementReceiptV1> {
    validateIdentity(input.contentRef, 'contentRef');
    validateIdentity(input.operationId, 'operationId');
    validateRevision(input.expectedOwnerRevision);
    validateActor(input.actor);
    const bytes = Buffer.from(input.bytes);
    const blobDigest = digestBytes(bytes);

    return this.store.withContentLock(input.contentRef, async () => {
      const state = await this.store.readState(input.contentRef);
      if (!state) throw new ContentOwnerNotFoundError(input.contentRef);
      validateContentPublication(state.publicationScope, input.sourcePublication);
      const fingerprint = operationFingerprint({
        contentRef: input.contentRef,
        expectedOwnerRevision: input.expectedOwnerRevision,
        blobDigest,
        mediaType: state.mediaType,
        actor: input.actor,
        publicationScope: state.publicationScope,
        sourcePublication: input.sourcePublication,
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
        sourcePublication: input.sourcePublication,
      });
    });
  }

  async load(contentRef: string, ownerRevision?: number): Promise<LoadedProjectContentV1> {
    const metadata = await this.describe(contentRef, ownerRevision);
    return { ...metadata, bytes: await this.store.readBlob(contentRef, metadata.blobDigest) };
  }

  async open(contentRef: string, ownerRevision: number) {
    const metadata = await this.describe(contentRef, ownerRevision);
    return { ...metadata, ...(await this.store.openBlob(contentRef, metadata.blobDigest)) };
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
      mediaType: current.mediaType,
      currentOwnerRevision: state.currentOwnerRevision,
      ...(state.publicationScope ? { publicationScope: { ...state.publicationScope } } : {}),
      ...(current.sourcePublication ? { sourcePublication: { ...current.sourcePublication } } : {}),
    };
  }

  async listOutbox(contentRef: string): Promise<readonly ContentSettlementReceiptV1[]> {
    validateIdentity(contentRef, 'contentRef');
    const state = await this.store.readState(contentRef);
    if (!state) throw new ContentOwnerNotFoundError(contentRef);
    return state.receipts.map((receipt) => ({ ...receipt, actor: { ...receipt.actor } }));
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
    readonly sourcePublication: ContentSourcePublicationV1 | undefined;
  }): Promise<ContentSettlementReceiptV1> {
    const previousOwnerRevision = input.previousState?.currentOwnerRevision ?? 0;
    const ownerRevision = previousOwnerRevision + 1;
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
    };

    await this.store.writeBlob(input.contentRef, input.blobDigest, input.bytes);
    await this.store.writeState(input.contentRef, state);
    return receipt;
  }
}

function resolveReplay(
  state: ProjectContentStateV1 | undefined,
  operationId: string,
  fingerprint: `sha256:${string}`,
): ContentSettlementReceiptV1 | undefined {
  const existing = state?.operations[operationId];
  if (!existing) return undefined;
  if (existing.fingerprint !== fingerprint) {
    throw new ContentOwnerIdempotencyError(state.contentRef, operationId);
  }
  const receipt = state.receipts.find((candidate) => candidate.receiptId === existing.receiptId);
  if (!receipt) throw new Error(`Receipt ${existing.receiptId} is missing for operation ${operationId}`);
  return receipt;
}

function operationFingerprint(input: {
  readonly contentRef: string;
  readonly expectedOwnerRevision: number;
  readonly blobDigest: `sha256:${string}`;
  readonly mediaType: string;
  readonly actor: ContentActorV1;
  readonly publicationScope: ContentPublicationScopeV1 | undefined;
  readonly sourcePublication: ContentSourcePublicationV1 | undefined;
}): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        contentRef: input.contentRef,
        expectedOwnerRevision: input.expectedOwnerRevision,
        blobDigest: input.blobDigest,
        mediaType: input.mediaType,
        actorKind: input.actor.kind,
        actorId: input.actor.actorId,
        publicationScope: input.publicationScope,
        sourcePublication: input.sourcePublication,
      }),
    )
    .digest('hex')}`;
}

function createReceiptId(
  contentRef: string,
  operationId: string,
  ownerRevision: number,
  blobDigest: `sha256:${string}`,
): string {
  return `content-receipt-${createHash('sha256')
    .update(`${contentRef}\0${operationId}\0${ownerRevision}\0${blobDigest}`)
    .digest('hex')}`;
}

function validateIdentity(value: string, field: string): void {
  if (value.length === 0 || value.length > 512 || value.trim() !== value || value.includes('\0')) {
    throw new TypeError(`${field} is invalid`);
  }
}

function validateActor(actor: ContentActorV1): void {
  validateIdentity(actor.actorId, 'actorId');
  if (actor.kind !== 'human' && actor.kind !== 'cat') throw new TypeError('actor kind is invalid');
}

function validateRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('expectedOwnerRevision must be a non-negative integer');
  }
}
