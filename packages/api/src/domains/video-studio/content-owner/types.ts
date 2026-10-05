import type {
  EvolutionMediaSnapshotSource,
  MessageMediaPublicationSource,
  WorkspaceMediaSnapshotSource,
} from '@cat-cafe/shared';

export type ContentActorV1 =
  | { readonly kind: 'human'; readonly actorId: string }
  | { readonly kind: 'cat'; readonly actorId: string };

/** Immutable authority coordinates established by an explicit prepared-publication import. */
export interface TaskContentPublicationScopeV1 {
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly taskId: string;
}

export interface MessageContentPublicationScopeV1 {
  readonly kind: 'message';
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly source: MessageMediaPublicationSource;
}

/** Legacy task scopes retain their exact serialized shape and content identity. */
export interface WorkspaceSnapshotPublicationScopeV1 {
  readonly kind: 'workspace-snapshot';
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly source: WorkspaceMediaSnapshotSource;
  readonly sourceContentRef: string;
  readonly snapshotOperationId: string;
}

export type ContentPublicationScopeV1 =
  | TaskContentPublicationScopeV1
  | MessageContentPublicationScopeV1
  | WorkspaceSnapshotPublicationScopeV1
  | EvolutionSnapshotPublicationScopeV1;

export interface EvolutionSnapshotPublicationScopeV1 {
  readonly kind: 'evolution-snapshot';
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly source: EvolutionMediaSnapshotSource;
  readonly sourceContentRef: string;
  readonly snapshotOperationId: string;
}

export function isTaskPublicationScope(scope: ContentPublicationScopeV1): scope is TaskContentPublicationScopeV1 {
  return !('kind' in scope);
}

export interface ContentSourcePublicationV1 {
  readonly artifactRef: string;
  readonly sourceRef: string;
  readonly revision: string;
  /** New returned versions may be published in an explicitly selected execution conversation. */
  readonly threadId?: string;
}

export interface ProjectContentRevisionV1 {
  readonly contentRef: string;
  readonly ownerRevision: number;
  readonly blobDigest: `sha256:${string}`;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly parentRevision: number | null;
  readonly committedBy: ContentActorV1;
  readonly operationId: string;
  readonly committedAt: string;
  readonly sourcePublication?: ContentSourcePublicationV1;
}

export interface ContentSettlementReceiptV1 {
  readonly receiptId: string;
  readonly contentRef: string;
  readonly previousOwnerRevision: number;
  readonly ownerRevision: number;
  readonly blobDigest: `sha256:${string}`;
  readonly actor: ContentActorV1;
  readonly operationId: string;
  readonly outboxSequence: number;
}

export interface LoadedProjectContentV1 {
  readonly contentRef: string;
  readonly ownerRevision: number;
  readonly blobDigest: `sha256:${string}`;
  readonly mediaType: string;
  readonly bytes: Buffer;
  readonly currentOwnerRevision: number;
  readonly publicationScope?: ContentPublicationScopeV1;
  readonly sourcePublication?: ContentSourcePublicationV1;
}

export interface ImportProjectContentInputV1 {
  readonly contentRef: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly actor: ContentActorV1;
  readonly operationId: string;
  readonly publicationScope?: ContentPublicationScopeV1;
  readonly sourcePublication?: ContentSourcePublicationV1;
}

export interface SettleProjectContentInputV1 {
  readonly contentRef: string;
  readonly expectedOwnerRevision: number;
  readonly bytes: Uint8Array;
  readonly actor: ContentActorV1;
  readonly operationId: string;
  readonly sourcePublication?: ContentSourcePublicationV1;
}
