import type { VideoProjectDocumentV1, VideoProjectReviewTarget } from '@cat-cafe/shared';
import type { ProjectReviewEvidence, ProjectReviewUsage } from './correspondence.js';
import { assetMaterial } from './material.js';

type Moment = Extract<VideoProjectReviewTarget, { kind: 'moment' }>;

/** Explicit ranges compare complete render inputs in their half-open window, never the first frame alone. */
export function momentRangeEvidence(document: VideoProjectDocumentV1, target: Moment): ProjectReviewEvidence {
  const endTick = target.endTick ?? target.tick + 1;
  const clip = (start: number, end: number) => {
    const startTick = Math.max(target.tick, start);
    const clippedEnd = Math.min(endTick, end);
    return startTick < clippedEnd ? { startTick, endTick: clippedEnd } : undefined;
  };
  const visuals = document.timeline.segments.flatMap((segment) =>
    segment.visuals.flatMap((visual) => {
      const sourceStart = segment.startTick + visual.startTick;
      const interval = clip(sourceStart, segment.startTick + visual.endTick);
      if (!interval) return [];
      const content = visual.assetVersionRef
        ? assetMaterial(document, visual.assetVersionRef)
        : { generated: visual.generated };
      if (
        target.region &&
        'mediaType' in content &&
        !content.mediaType.startsWith('image/') &&
        !content.mediaType.startsWith('video/')
      )
        return [];
      const usage: ProjectReviewUsage = {
        key: `visual:${visual.id}`,
        position: 'visual',
        ...interval,
        assetVersionRef: visual.assetVersionRef,
        content,
      };
      // A moving/encoded source starts at its visual-use boundary, even when clipping hides that boundary.
      const sourceOffsetTicks =
        'mediaType' in content && content.mediaType.startsWith('image/') ? undefined : interval.startTick - sourceStart;
      return [{ usage, value: { ...interval, content, sourceOffsetTicks } }];
    }),
  );
  // Generic events currently have no spatial placement, so none proves pixels inside a region.
  const events = target.region
    ? []
    : document.timeline.events.flatMap((event) => {
        const interval = clip(event.startTick, event.startTick + (event.durationTicks ?? 1));
        if (!interval) return [];
        const content = event.assetVersionRef ? assetMaterial(document, event.assetVersionRef) : undefined;
        const usage: ProjectReviewUsage = {
          key: `event:${event.id}`,
          position: `event:${event.kind}`,
          ...interval,
          assetVersionRef: event.assetVersionRef,
          content,
        };
        return [
          {
            usage,
            value: {
              ...interval,
              kind: event.kind,
              text: event.text,
              speaker: event.speaker,
              content,
              sourceOffsetTicks: event.assetVersionRef ? interval.startTick - event.startTick : undefined,
            },
          },
        ];
      });
  return {
    value: {
      canvas: {
        timebase: document.timeline.timebase,
        width: document.timeline.width,
        height: document.timeline.height,
      },
      visuals: visuals.map((item) => item.value),
      events: events.map((item) => item.value),
    },
    usages: [...visuals.map((item) => item.usage), ...events.map((item) => item.usage)],
  };
}
