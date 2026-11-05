import { createHash } from 'node:crypto';
import type { CollectiveContentScopeV1 } from './collective-scope.js';
import type {
  ContentActorV1,
  ContentOperationContextV1,
  ContentPublicationScopeV1,
  ContentSourcePublicationV1,
  VideoProjectMediaScopeV1,
  VideoProjectScopeV1,
} from './types.js';

export function operationFingerprint(input: {
  readonly contentRef: string;
  readonly expectedOwnerRevision: number;
  readonly blobDigest: `sha256:${string}`;
  readonly mediaType: string;
  readonly actor: ContentActorV1;
  readonly publicationScope: ContentPublicationScopeV1 | undefined;
  readonly projectScope: VideoProjectScopeV1 | undefined;
  readonly projectMediaScope?: VideoProjectMediaScopeV1;
  readonly operationContext: ContentOperationContextV1 | undefined;
  readonly sourcePublication: ContentSourcePublicationV1 | undefined;
  readonly collectiveScope?: CollectiveContentScopeV1;
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
        projectScope: input.projectScope,
        projectMediaScope: input.projectMediaScope,
        operationContext: input.operationContext,
        sourcePublication: input.sourcePublication,
        ...(input.collectiveScope ? { collectiveScope: input.collectiveScope } : {}),
      }),
    )
    .digest('hex')}`;
}

export function createReceiptId(
  contentRef: string,
  operationId: string,
  ownerRevision: number,
  blobDigest: `sha256:${string}`,
): string {
  return `content-receipt-${createHash('sha256')
    .update(`${contentRef}\0${operationId}\0${ownerRevision}\0${blobDigest}`)
    .digest('hex')}`;
}
