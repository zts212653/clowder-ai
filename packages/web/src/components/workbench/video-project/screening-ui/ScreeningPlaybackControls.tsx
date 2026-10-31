import type { VideoProjectScreening, VideoProjectSegment } from '@cat-cafe/shared';
import { tickToBrowserTime } from '../../../content-review/review-geometry';
import { useScreeningCopy } from './screening.shell-copy';
import { adjacentFrameSeekSeconds } from './screening-frame-step';

/** Playback controls use verified media frames while the status names the selected input shot. */
export function ScreeningPlaybackControls({
  media,
  pts,
  current,
  loop,
  onLoop,
  onSeek,
  opinionPositions = [],
}: {
  media: VideoProjectScreening['media']['media'];
  pts: number | null;
  current: VideoProjectSegment | undefined;
  loop: boolean;
  onLoop: () => void;
  onSeek: (seconds: number) => void;
  opinionPositions?: { id: string; pts: number }[];
}) {
  const t = useScreeningCopy();
  const previous = adjacentFrameSeekSeconds(media, pts, -1);
  const next = adjacentFrameSeekSeconds(media, pts, 1);
  const positions = opinionPositions.slice().sort((left, right) => left.pts - right.pts);
  const previousIssue =
    pts === null
      ? undefined
      : positions
          .slice()
          .reverse()
          .find((item) => item.pts < pts);
  const nextIssue = pts === null ? undefined : positions.find((item) => item.pts > pts);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-cafe-secondary">
      <button
        type="button"
        disabled={previous === null}
        title={media.frameRate ? t.previousFrame : t.noFps}
        onClick={() => previous !== null && onSeek(previous)}
      >
        ‹ {t.previousFrame}
      </button>
      <button type="button" disabled={next === null} onClick={() => next !== null && onSeek(next)}>
        {t.nextFrame} ›
      </button>
      <button type="button" disabled={!current} aria-pressed={loop} onClick={onLoop}>
        ↻ {t.loop}
      </button>
      <button
        type="button"
        disabled={!previousIssue}
        onClick={() => previousIssue && onSeek(tickToBrowserTime(previousIssue.pts, media))}
      >
        {t.previousIssue}
      </button>
      <button
        type="button"
        disabled={!nextIssue}
        onClick={() => nextIssue && onSeek(tickToBrowserTime(nextIssue.pts, media))}
      >
        {t.nextIssue}
      </button>
      <span className="ml-auto">{pts === null ? t.confirming : current ? current.label : t.unmapped}</span>
    </div>
  );
}
