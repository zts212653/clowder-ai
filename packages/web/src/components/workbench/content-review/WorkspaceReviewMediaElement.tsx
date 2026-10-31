import type { ImmutableMedia } from '@cat-cafe/shared';
import { type RefObject, useCallback } from 'react';
import { ContentMediaElement } from '@/components/content-review/ContentMediaElement';
import { videoArtworkCopy } from '@/components/content-review/video-artwork.shell-copy';
import { useShellCopy } from '@/components/shell/shell-copy';

export function WorkspaceReviewMediaElement({
  src,
  error,
  media,
  video,
  selectionActive,
  customControls = false,
  onSeeking,
  onSeeked,
  onSeconds,
  onError,
}: {
  src: string | null;
  error: string | null;
  media: ImmutableMedia;
  video: RefObject<HTMLVideoElement>;
  selectionActive: boolean;
  customControls?: boolean;
  onSeeking: () => void;
  onSeeked: () => void;
  onSeconds: (seconds: number) => void;
  onError: (error: string) => void;
}) {
  const t = useShellCopy(videoArtworkCopy);
  // Next/Image reassigns src when its error callback changes; keep ordinary canvas renders from restarting pixels.
  const imageError = useCallback(() => onError(t.imageError), [onError, t.imageError]);
  if (!src) return <p className="p-4 text-sm text-cafe-muted">{error ?? t.loading}</p>;
  if (media.kind === 'image')
    return (
      <ContentMediaElement
        kind="image"
        src={src}
        title={t.imageAlt}
        width={media.width}
        height={media.height}
        className="absolute inset-0 h-full w-full object-contain"
        testId="workspace-content-review-media"
        onError={imageError}
      />
    );
  return (
    <ContentMediaElement
      kind="video"
      src={src}
      videoRef={video}
      className="absolute inset-0 h-full w-full object-contain"
      testId="workspace-content-review-media"
      videoProps={{
        controls: !selectionActive && !customControls,
        onSeeking,
        onSeeked,
        onTimeUpdate: (event) => onSeconds(event.currentTarget.currentTime),
      }}
      onError={() => onError(t.videoError)}
    />
  );
}
