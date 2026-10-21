import type {
  EvolutionMediaSnapshotSource,
  MessageMediaPublicationSource,
  WorkspaceMediaSnapshotSource,
} from '@cat-cafe/shared';
import type { CollectiveContentOperationContextV1, CollectiveContentScopeV1 } from './collective-scope.js';

export type ContentActorV1 =
  | { readonly kind: 'human'; readonly actorId: string }
  | { readonly kind: 'cat'; readonly actorId: string };

export interface VideoProjectScopeV1 {
  readonly kind: 'video-project';
  readonly ownerUserId: string;
  readonly projectId: string;
}

export interface VideoProjectMediaScopeV1 {
  readonly kind: 'video-project-screening';
  readonly ownerUserId: string;
  readonly projectContentRef: string;
  readonly screeningId: string;
  readonly input: {
    readonly contentRef: string;
    readonly ownerRevision: number;
    readonly blobDigest: `sha256:${string}`;
  };
  readonly source: {
    readonly locator: { readonly worktreeId: string; readonly path: string };
    readonly expectedSourceRevision: string;
  };
  readonly sourceContentRef: string;
  readonly snapshotOperationId: string;
  readonly requestDigest: `sha256:${string}`;
  readonly registeredBy: ContentActorV1;
  readonly registeredAt: string;
}

/** Optional domain request provenance lives on the existing owner receipt, not a second operation journal. */
export interface VideoContentOperationContextV1 {
  readonly kind:
    | 'video-project:create'
    | 'video-project:save'
    | 'video-project:archive'
    | 'video-project:decision'
    | 'video-project:screening'
    | 'video-project:self-review';
  readonly requestDigest: `sha256:${string}`;
}
export interface WorkContentOperationContextV1 {
  readonly kind: 'work:create' | 'work:submit';
  readonly requestDigest: `sha256:${string}`;
}
export type ContentOperationContextV1 =
  | VideoContentOperationContextV1
  | CollectiveContentOperationContextV1
  | WorkContentOperationContextV1;

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
  | EvolutionSnapshotPublicationScopeV1
  | WorkPublicationScopeV1;

/** Independent works retain their original production authority, not a mutable source path or message. */
export interface WorkPublicationScopeV1 {
  readonly kind: 'work';
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly creationOperationId: string;
  readonly createdBy: ContentActorV1;
}

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

export function isWorkPublicationScope(scope: ContentPublicationScopeV1 | undefined): scope is WorkPublicationScopeV1 {
  return scope !== undefined && 'kind' in scope && scope.kind === 'work';
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
  readonly operationContext?: ContentOperationContextV1;
}

export interface LoadedProjectContentV1 {
  readonly collectiveScope?: CollectiveContentScopeV1;
  readonly byteLength: number;
  readonly contentRef: string;
  readonly ownerRevision: number;
  readonly blobDigest: `sha256:${string}`;
  readonly mediaType: string;
  readonly bytes: Buffer;
  readonly currentOwnerRevision: number;
  readonly publicationScope?: ContentPublicationScopeV1;
  readonly projectScope?: VideoProjectScopeV1;
  readonly projectMediaScope?: VideoProjectMediaScopeV1;
  readonly sourcePublication?: ContentSourcePublicationV1;
}

export interface ImportProjectContentInputV1 {
  readonly collectiveScope?: CollectiveContentScopeV1;
  readonly authorizeEffect?: () => Promise<void>;
  readonly contentRef: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly actor: ContentActorV1;
  readonly operationId: string;
  readonly publicationScope?: ContentPublicationScopeV1;
  readonly projectScope?: VideoProjectScopeV1;
  readonly projectMediaScope?: VideoProjectMediaScopeV1;
  readonly sourcePublication?: ContentSourcePublicationV1;
  readonly operationContext?: ContentOperationContextV1;
}

export interface SettleProjectContentInputV1 {
  readonly authorizeEffect?: () => Promise<void>;
  readonly contentRef: string;
  readonly expectedOwnerRevision: number;
  readonly bytes: Uint8Array;
  readonly actor: ContentActorV1;
  readonly operationId: string;
  readonly sourcePublication?: ContentSourcePublicationV1;
  readonly operationContext?: ContentOperationContextV1;
}
