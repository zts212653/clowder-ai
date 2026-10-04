import type { ArtifactReviewAnchor, ImmutableMedia } from '@cat-cafe/shared';
import { type RefObject, useEffect, useRef } from 'react';
import { tickToBrowserTime } from '@/components/content-review/review-geometry';

type AttachedAnnotation = { readonly id: string; readonly anchor: ArtifactReviewAnchor };
export type CanvasFocusRequest = { readonly annotationId: string; readonly requestId: number };
export type DiscussionFocusRequest = { readonly annotationId: string; readonly requestId: number };

function activeVideoSeekTarget(
  media: ImmutableMedia,
  annotations: readonly AttachedAnnotation[],
  activeAnnotationId: string | null,
): number | null {
  const annotation = annotations.find((item) => item.id === activeAnnotationId);
  if (media.kind !== 'video' || annotation?.anchor.kind !== 'video-range') return null;
  return tickToBrowserTime(
    annotation.anchor.frameRegion?.tick ?? annotation.anchor.framePoint?.tick ?? annotation.anchor.startTick,
    media,
  );
}

export function useCanvasFocus(
  stage: RefObject<HTMLDivElement | null>,
  canvasFocusRequest: CanvasFocusRequest | null | undefined,
) {
  const focusedRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!canvasFocusRequest || focusedRequest.current === canvasFocusRequest.requestId) return;
    const marks = stage.current?.querySelectorAll<SVGGElement>('[data-annotation-id]');
    const mark = [...(marks ?? [])].find((item) => item.dataset.annotationId === canvasFocusRequest.annotationId);
    if (!mark) return;
    mark.focus();
    focusedRequest.current = canvasFocusRequest.requestId;
  }, [canvasFocusRequest, stage]);
}

export function useDiscussionVideoSeek({
  media,
  annotations,
  activeAnnotationId,
  discussionFocusRequest,
  src,
  seekTo,
  setSeconds,
}: {
  readonly media: ImmutableMedia;
  readonly annotations: readonly AttachedAnnotation[];
  readonly activeAnnotationId: string | null;
  readonly discussionFocusRequest: DiscussionFocusRequest | null | undefined;
  readonly src: string;
  readonly seekTo: (seconds: number) => void;
  readonly setSeconds: (seconds: number) => void;
}) {
  const locationRequest = discussionFocusRequest ?? activeAnnotationId;
  const seekTarget = activeVideoSeekTarget(
    media,
    annotations,
    typeof locationRequest === 'string' ? locationRequest : (locationRequest?.annotationId ?? null),
  );
  useEffect(() => {
    if (!src || !locationRequest || seekTarget === null) return;
    setSeconds(seekTarget);
    seekTo(seekTarget);
  }, [locationRequest, seekTarget, seekTo, setSeconds, src]);
}
