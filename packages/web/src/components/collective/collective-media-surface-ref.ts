import {
  type CollectiveClientContext,
  type CollectiveMediaSurfaceRefV1,
  collectiveMediaSurfaceOpenSchema,
} from '@cat-cafe/shared';
import type { CollectiveConnectionProjection } from './collective-client';

type Connection = Pick<
  CollectiveConnectionProjection,
  'serviceInstanceId' | 'collectiveId' | 'connectionId' | 'authorizedHumanId' | 'authorityStatus'
>;
export function mediaSurfaceRefMatches(
  ref: Omit<CollectiveMediaSurfaceRefV1, 'artifactId' | 'ownerRevision'>,
  context: CollectiveClientContext | undefined,
  connection: Connection | undefined,
): boolean {
  return Boolean(
    context &&
      connection &&
      connection.authorityStatus === 'connected' &&
      ref.bridgeId === context.bridgeId &&
      ref.contextId === context.contextId &&
      ref.contextRevision === context.revision &&
      ref.serviceInstanceId === context.serviceInstanceId &&
      ref.collectiveId === context.collectiveId &&
      ref.humanId === context.humanId &&
      ref.channelId === context.channelId &&
      context.channelIds.includes(ref.channelId) &&
      ref.serviceInstanceId === connection.serviceInstanceId &&
      ref.collectiveId === connection.collectiveId &&
      ref.connectionId === connection.connectionId &&
      ref.humanId === connection.authorizedHumanId,
  );
}
export function readMediaSurfaceRef(
  data: unknown,
  context: CollectiveClientContext | undefined,
  connection: Connection | undefined,
) {
  const parsed = collectiveMediaSurfaceOpenSchema.safeParse(data);
  return parsed.success && mediaSurfaceRefMatches(parsed.data.ref, context, connection) ? parsed.data.ref : undefined;
}
