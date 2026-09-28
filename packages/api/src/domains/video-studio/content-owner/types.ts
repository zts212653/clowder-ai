export type ContentActorV1 =
  | { readonly kind: 'human'; readonly actorId: string }
  | { readonly kind: 'cat'; readonly actorId: string };

/** Immutable authority coordinates established by an explicit prepared-publication import. */
export interface ContentPublicationScopeV1 {
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly taskId: string;
}

export interface ContentSourcePublicationV1 {
  readonly artifactRef: string;
  readonly sourceRef: string;
  readonly revision: string;
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
