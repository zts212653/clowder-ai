import type { ArtifactReviewAnchor, ImmutableMedia } from '@cat-cafe/shared';
import { type RefObject, useEffect, useRef, useState } from 'react';
import type { ReviewCanvasMode } from '@/components/content-review/ReviewCanvasToolbar';
import { browserTimeToTick } from '@/components/content-review/review-geometry';

/** Consume work-header requests only on the active decoded picture; hiding/refusal cancels unsent intents. */
export function useVideoWorkRequests({
  video,
  media,
  frameTime,
  visible,
  selectable,
  markRequest = 0,
  selectionRequest,
  playbackHidden = false,
  seekRequest,
  seekTo,
  setSeconds,
  setMode,
  onSelect,
}: {
  video: RefObject<HTMLVideoElement>;
  media: ImmutableMedia;
  frameTime: number | null;
  visible: boolean;
  selectable: boolean;
  markRequest?: number;
  selectionRequest?: { id: number; anchor: ArtifactReviewAnchor };
  playbackHidden?: boolean;
  seekRequest?: { id: number; seconds: number };
  seekTo: (seconds: number) => void;
  setSeconds: (seconds: number) => void;
  setMode: (mode: ReviewCanvasMode) => void;
  onSelect: (anchor: ArtifactReviewAnchor) => void;
}) {
  const consumedSeek = useRef<number>();
  const consumedSelection = useRef(selectionRequest?.id);
  const [consumedMark, setConsumedMark] = useState(markRequest);
  const queued = markRequest !== consumedMark;
  const active = visible && !playbackHidden;
  useEffect(() => {
    if (!selectionRequest || selectionRequest.id === consumedSelection.current) return;
    consumedSelection.current = selectionRequest.id;
    if (!active || !selectable || media.kind !== 'video') return;
    const anchor = selectionRequest.anchor;
    if (
      anchor.kind !== 'video-range' ||
      anchor.streamId !== media.streamId ||
      anchor.startTick < media.startTick ||
      anchor.endTick > media.startTick + media.durationTicks
    )
      return;
    video.current?.pause();
    setMode('comment');
    onSelect(anchor);
  }, [selectionRequest, active, selectable, media, video, setMode, onSelect]);
  useEffect(() => {
    if (!seekRequest || seekRequest.id === consumedSeek.current) return;
    consumedSeek.current = seekRequest.id;
    if (!active || media.kind !== 'video') return;
    video.current?.pause();
    seekTo(seekRequest.seconds);
    setSeconds(seekRequest.seconds);
  }, [seekRequest, active, media.kind, video, seekTo, setSeconds]);
  useEffect(() => {
    if (active && selectable) return;
    if (!active) video.current?.pause();
    setConsumedMark(markRequest);
  }, [active, selectable, video, markRequest]);
  useEffect(() => {
    if (!queued || !active || !selectable || media.kind !== 'video' || frameTime === null) return;
    setConsumedMark(markRequest);
    const tick = browserTimeToTick(frameTime, media);
    if (tick < media.startTick || tick >= media.startTick + media.durationTicks) return;
    video.current?.pause();
    setMode('comment');
    onSelect({
      kind: 'video-range',
      streamId: media.streamId,
      startTick: tick,
      endTick: Math.min(tick + 1, media.startTick + media.durationTicks),
    });
  }, [queued, active, selectable, media, frameTime, markRequest, video, setMode, onSelect]);
  return queued && active && selectable;
}
