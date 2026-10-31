import { actor, digest, origin } from './video-project.fixtures.js';

export function screening() {
  return {
    id: 'screening-1',
    title: 'EP0 第一版',
    input: { contentRef: 'project-1', ownerRevision: 1, blobDigest: digest },
    media: {
      contentRef: 'media-1',
      ownerRevision: 1,
      blobDigest: digest,
      byteLength: 500,
      media: {
        kind: 'video' as const,
        width: 1280,
        height: 720,
        codedWidth: 1280,
        codedHeight: 720,
        rotation: 0 as const,
        pixelAspectRatio: { numerator: 1, denominator: 1 },
        streamId: 'video-0',
        streamIndex: 0,
        timebase: { numerator: 1, denominator: 15360 },
        startTick: 0,
        durationTicks: 61440,
        containerStartSeconds: 0,
      },
    },
    mapping: {
      segments: [
        { mediaStartPts: 0, mediaEndPts: 51200, projectStartTick: 0, projectEndTick: 100, refs: ['render:1'] },
      ],
      frame: { displayWidth: 1280, displayHeight: 720, canvasWidth: 1920, canvasHeight: 1080, rotation: 0 as const },
    },
    actor,
    at: origin.at,
    operationId: 'register-1',
    refs: ['message:1'],
  };
}
