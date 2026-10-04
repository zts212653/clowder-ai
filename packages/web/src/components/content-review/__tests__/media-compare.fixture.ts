import type { ReviewedMediaAsset } from '@cat-cafe/shared';
export function compareAsset(revision: number, kind: 'image' | 'video' = 'image', width = 390): ReviewedMediaAsset {
  return {
    contentRef: 'published-pair',
    ownerRevision: revision,
    blobDigest: `sha256:${String(revision).repeat(64)}`,
    ownerReceiptRef: `receipt:${revision}`,
    sourcePublication: {
      artifactRef: `/uploads/${revision}.${kind === 'image' ? 'png' : 'mp4'}`,
      sourceRef: 'message:original',
      revision: String(revision),
    },
    mediaType: kind === 'image' ? 'image/png' : 'video/mp4',
    media:
      kind === 'image'
        ? { kind, width, height: 844 }
        : {
            kind,
            width,
            height: 640,
            codedWidth: width,
            codedHeight: 640,
            rotation: 0,
            pixelAspectRatio: { numerator: 1, denominator: 1 },
            streamId: `stream:${revision}`,
            streamIndex: 0,
            timebase: { numerator: 1, denominator: 1000 },
            startTick: revision * 1000,
            durationTicks: revision * 2000,
            containerStartSeconds: revision,
          },
  };
}
