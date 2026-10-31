import type { VideoProjectSegment } from '@cat-cafe/shared';
import type { ScreeningCompareSide } from '../video-project/compare-alignment';

export function comparisonShot(id: string, startTick: number, durationTicks: number): VideoProjectSegment {
  return {
    id,
    kind: 'shot',
    label: id,
    startTick,
    durationTicks,
    visuals: [{ id: `${id}:visual`, generated: { color: 'red' }, startTick: 0, endTick: durationTicks }],
  };
}
export function comparisonSide(
  id: string,
  segments: VideoProjectSegment[],
  tailTicks = 0,
  startPts = 0,
): ScreeningCompareSide {
  const durationTicks = Math.max(...segments.map((segment) => segment.startTick + segment.durationTicks));
  const at = '2026-10-10T15:00:00.000Z';
  const digest = `sha256:${(id === 'old' ? 'a' : 'b').repeat(64)}`;
  const input = { contentRef: 'project-1', ownerRevision: id === 'old' ? 1 : 2, blobDigest: digest };
  return {
    input: {
      ...input,
      document: {
        schemaVersion: 1,
        title: 'EP0',
        kind: 'animation',
        tags: [],
        roles: [],
        origin: { kind: 'created', actor: { kind: 'human', actorId: 'owner' }, at, refs: ['message:1'] },
        timeline: {
          timebase: { numerator: 1, denominator: 10 },
          durationTicks,
          width: 1920,
          height: 1080,
          scenes: [],
          segments,
          events: [],
        },
        assets: [],
        checkPages: [],
        checkResults: [],
        decisions: [],
      },
    },
    screening: {
      id,
      title: id,
      input,
      actor: { kind: 'human', actorId: 'owner' },
      at,
      operationId: `register:${id}`,
      refs: ['render:1'],
      media: {
        contentRef: `media:${id}`,
        ownerRevision: 1,
        blobDigest: digest,
        byteLength: 500,
        media: {
          kind: 'video',
          width: 1280,
          height: 720,
          codedWidth: 1280,
          codedHeight: 720,
          rotation: 0,
          pixelAspectRatio: { numerator: 1, denominator: 1 },
          streamId: 'video',
          streamIndex: 0,
          timebase: { numerator: 1, denominator: 1000 },
          startTick: startPts,
          durationTicks: (durationTicks + tailTicks) * 100,
          containerStartSeconds: startPts / 1000,
        },
      },
      mapping: {
        segments: [
          {
            mediaStartPts: startPts,
            mediaEndPts: startPts + durationTicks * 100,
            projectStartTick: 0,
            projectEndTick: durationTicks,
            refs: ['render:1'],
          },
        ],
        frame: { displayWidth: 1280, displayHeight: 720, canvasWidth: 1920, canvasHeight: 1080, rotation: 0 },
      },
    },
    mediaUrl: `/api/video-projects/project-1/screenings/${id}/media`,
  };
}
