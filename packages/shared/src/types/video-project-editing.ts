import { videoProjectPositiveSchema } from './video-project-primitives.js';
import { evenAssetSwitchStarts } from './video-project-switching.js';
import { type VideoProjectSegment, videoProjectSegmentSchema } from './video-project-timeline.js';

/** Preserve opaque renderer instructions; callers still validate the surrounding project timeline. */
export function resizeVideoProjectSegment(segment: VideoProjectSegment, durationTicks: number): VideoProjectSegment {
  const resized = videoProjectSegmentSchema.parse(segment);
  const previousDuration = resized.durationTicks;
  resized.durationTicks = videoProjectPositiveSchema.parse(durationTicks);
  const assets = resized.visuals.filter((visual) => visual.assetVersionRef !== undefined);
  if (resized.switchMode !== undefined) {
    const starts =
      resized.switchMode === 'even'
        ? evenAssetSwitchStarts(resized.durationTicks, assets.length)
        : assets.map((visual) => visual.startTick);
    assets.forEach((visual, index) => {
      visual.startTick = starts[index] ?? 0;
      visual.endTick = starts[index + 1] ?? resized.durationTicks;
    });
  }
  for (const visual of resized.visuals) {
    if (visual.generated !== undefined && visual.startTick === 0 && visual.endTick === previousDuration) {
      visual.endTick = resized.durationTicks;
    }
  }
  return videoProjectSegmentSchema.parse(resized);
}
