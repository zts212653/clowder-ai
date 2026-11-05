import type { CollectiveArtifactProjection, CollectiveMediaSurfaceRefV1, CollectiveMediaView } from '@cat-cafe/shared';

export const mediaRef: CollectiveMediaSurfaceRefV1 = {
  v: 1,
  bridgeId: 'bridge_12345678',
  contextId: 'context_12345678',
  contextRevision: 1,
  serviceInstanceId: 'svc_12345678',
  collectiveId: 'col_12345678',
  connectionId: 'con_12345678',
  humanId: 'human_12345678',
  channelId: 'general',
  artifactId: 'artifact_png',
  sourceEventId: 'evt_12345678',
  ownerRevision: 1,
};
const digest = `sha256:${'a'.repeat(64)}`;
export const mediaArtifact: CollectiveArtifactProjection = {
  serviceInstanceId: mediaRef.serviceInstanceId,
  collectiveId: mediaRef.collectiveId,
  artifactId: mediaRef.artifactId,
  contentRef: 'retained-content',
  publishedByHumanId: 'human_87654321',
  title: '同一幅画',
  mediaType: 'image/png',
  sourceEventId: mediaRef.sourceEventId,
  sourceLocation: { channelId: mediaRef.channelId },
  revision: 1,
  accessRevision: 1,
  canApply: false,
  availability: 'available',
  versionCount: 1,
  versions: [
    { ownerRevision: 1, blobDigest: digest, receiptRef: 'retained-receipt', recordedAt: '2026-10-16T00:00:00Z' },
  ],
  createdAt: '2026-10-16T00:00:00Z',
  updatedAt: '2026-10-16T00:00:00Z',
};
export function mediaProjection(): CollectiveMediaView {
  const source = {
    kind: 'collective-media' as const,
    contentRef: mediaArtifact.contentRef,
    ownerRevision: 1,
    blobDigest: digest,
    ownerReceiptRef: 'retained-receipt',
    revision: digest,
    mime: 'image/png' as const,
    media: { kind: 'image' as const, width: 160, height: 100 },
  };
  return {
    kind: 'collective-media',
    contentRef: source.contentRef,
    ownerRevision: 1,
    blobDigest: digest,
    ownerReceiptRef: source.ownerReceiptRef,
    mediaType: 'image/png',
    media: source.media,
    view: {
      review: {
        version: 1,
        reviewId: 'public-ledger',
        contentRef: 'collective-media-ledger:opaque',
        source,
        revision: 1,
        annotations: [],
        createdAt: '2026-10-16T00:00:00Z',
        updatedAt: '2026-10-16T00:00:00Z',
        collaborationScope: {
          kind: 'collective-artifact',
          scopeRef: 'public-scope',
          serviceInstanceId: mediaRef.serviceInstanceId,
          collectiveId: mediaRef.collectiveId,
          artifactId: mediaRef.artifactId,
          sourceEventId: mediaRef.sourceEventId,
          custodyRevision: 1,
        },
      },
      currentSource: source,
      sourceState: 'current',
      canWrite: true,
      canReply: true,
      historyReadOnly: false,
      annotationPage: { offset: 0, total: 0 },
      replyPages: [],
      annotationResolutions: [],
    },
  };
}
