import type { VideoProjectScreening } from '@cat-cafe/shared';
import { browserTimeToTick } from '../../../content-review/review-geometry';
import type { ProjectSnapshot } from '../api';
import { queueScreeningSelection, screeningSelection } from '../selection';

/** The decoded frame determines both the interval and the immutable composer chip. */
export function queuePresentedScreeningSelection(input: {
  threadId: string;
  screening: VideoProjectScreening;
  project: ProjectSnapshot;
  pts: number;
  rangeStart: number | null;
  frameSeconds: number | null;
  mode: 'moment' | 'segment' | 'project';
  region: Parameters<typeof screeningSelection>[0]['displayRegion'];
}) {
  const { screening, project, pts, rangeStart, frameSeconds, mode, region } = input;
  const media = screening.media.media;
  const lower = Math.min(rangeStart ?? pts, pts);
  const end = Math.min(
    media.startTick + media.durationTicks,
    Math.max(rangeStart ?? pts, pts) + Math.max(1, frameSeconds ? browserTimeToTick(frameSeconds, media) : 1),
  );
  const selection = screeningSelection({
    screening,
    document: project.document,
    mode,
    mediaRange: { startPts: lower, endPts: end },
    displayRegion: mode === 'moment' ? region : undefined,
  });
  return queueScreeningSelection(input.threadId, {
    v: 1,
    kind: 'project-screening',
    id: crypto.randomUUID(),
    title: `${project.document.title} · ${screening.title}`,
    contentRef: project.contentRef,
    screeningId: screening.id,
    input: screening.input,
    media: {
      contentRef: screening.media.contentRef,
      ownerRevision: screening.media.ownerRevision,
      blobDigest: screening.media.blobDigest,
    },
    selections: [selection],
  });
}
