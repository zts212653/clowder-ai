import { type CollectiveContentScopeV1, requireCollectiveContentCapacity } from './collective-scope.js';
import { ContentOwnerIdempotencyError } from './errors.js';
import { createReceiptId } from './operation-identity.js';
import type { ProjectContentOwnerStore, ProjectContentStateV1 } from './store.js';
import type { ContentStream } from './stream-content.js';
import type {
  ContentActorV1,
  ContentOperationContextV1,
  ContentPublicationScopeV1,
  ContentSettlementReceiptV1,
  ContentSourcePublicationV1,
  ProjectContentRevisionV1,
  VideoProjectMediaScopeV1,
  VideoProjectScopeV1,
} from './types.js';

export interface ContentCommitInput {
  readonly contentRef: string;
  readonly previousState: ProjectContentStateV1 | undefined;
  readonly mediaType: string;
  readonly bytes: Buffer | ContentStream;
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
}

export async function commitContentRevision(
  store: ProjectContentOwnerStore,
  now: () => string,
  input: ContentCommitInput,
): Promise<ContentSettlementReceiptV1> {
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
    committedAt: now(),
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

  await persistOwnerRevision(store, input, state);
  return receipt;
}

async function persistOwnerRevision(
  store: ProjectContentOwnerStore,
  input: ContentCommitInput,
  state: ProjectContentStateV1,
) {
  if (!input.previousState && input.authorizeEffect && (input.collectiveScope || !Buffer.isBuffer(input.bytes))) {
    await store.commitInitialState(state, input.bytes, input.authorizeEffect);
  } else {
    await store.writeBlob(input.contentRef, input.blobDigest, input.bytes);
    await store.writeState(input.contentRef, state, input.authorizeEffect);
  }
}

export function resolveReplay(
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
