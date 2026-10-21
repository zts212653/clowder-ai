import { Readable } from 'node:stream';
import {
  type CollectiveMediaDescriptor,
  collectiveMediaBufferBytes,
  collectiveMediaOperationSchema,
  parseMediaByteRange,
} from '@cat-cafe/shared';
import { ZodError } from 'zod';
import { WorkspaceContentReviewError } from '../workspace-review/errors.js';
import { admitCollectiveMedia } from './media-authority.js';
import type { CollectiveMediaReviews } from './media-reviews.js';
import type { CollectiveArtifactMediaReadPort, CollectiveArtifactOwnerResult } from './owner-port.js';
import type { CollectivePublishedMediaOwner } from './published-media-owner.js';

export function publishedMediaReadPort(
  deps: CollectivePublishedMediaOwner['deps'],
  reviews: CollectiveMediaReviews,
): CollectiveArtifactMediaReadPort {
  return {
    async read(unsafe, authority, signal) {
      let opened: Awaited<ReturnType<typeof deps.media.openAsset>> | undefined;
      try {
        signal.throwIfAborted();
        const operation = collectiveMediaOperationSchema.parse(unsafe);
        const admitted = await admitCollectiveMedia(
          deps,
          reviews,
          { ...operation, requestId: operation.relayRef, payload: {} },
          authority,
        );
        const principal = { userId: deps.ownerUserId, actor: { kind: 'human' as const, actorId: deps.ownerUserId } };
        const asset = await deps.media.read(admitted.asset.contentRef, admitted.asset.ownerRevision, principal);
        opened = await deps.media.openAsset(asset, principal);
        await admitted.authorize();
        signal.throwIfAborted();
        const base = {
          contentRef: asset.contentRef,
          ownerRevision: asset.ownerRevision,
          blobDigest: asset.blobDigest,
          ownerReceiptRef: asset.ownerReceiptRef,
          mediaType: admitted.asset.mediaType,
          byteLength: opened.byteLength,
        };
        const range =
          operation.range === undefined ? undefined : parseMediaByteRange(operation.range, opened.byteLength);
        if (range === null) {
          await opened.handle.close();
          return { status: 'ok', descriptor: { ...base, status: 416 }, body: Readable.from([]) };
        }
        const descriptor: CollectiveMediaDescriptor = { ...base, status: range ? 206 : 200, ...range };
        const body = opened.handle.createReadStream({
          autoClose: true,
          highWaterMark: collectiveMediaBufferBytes,
          ...range,
        });
        const abort = () => body.destroy();
        signal.addEventListener('abort', abort, { once: true });
        body.once('close', () => signal.removeEventListener('abort', abort));
        return { status: 'ok', descriptor, body };
      } catch (error) {
        await opened?.handle.close().catch(() => {});
        if (signal.aborted) return { status: 'error', error: { code: 'owner_unavailable' } };
        return mediaOwnerError(error);
      }
    },
  };
}

export function mediaOwnerError(error: unknown): Extract<CollectiveArtifactOwnerResult, { status: 'error' }> {
  if (error instanceof ZodError) return { status: 'error', error: { code: 'invalid_request' } };
  if (error instanceof WorkspaceContentReviewError) {
    if (error.code === 'unsupported_content') return { status: 'error', error: { code: 'unsupported_operation' } };
    if (['source_changed', 'revision_conflict', 'operation_reused'].includes(error.code))
      return { status: 'error', error: { code: 'conflict' } };
  }
  if (error instanceof Error && 'code' in error && error.code === 'media_unavailable')
    return { status: 'error', error: { code: 'owner_unavailable' } };
  return { status: 'error', error: { code: 'access_denied' } };
}
