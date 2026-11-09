'use client';
import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { ShellGlyph } from '@/components/shell/ShellIcons';
import { useShellCopy } from '@/components/shell/shell-copy';
import { API_URL } from '@/utils/api-client';
import { resolveAssetUrl } from './artifact-view';
import { useNearWorkViewport } from './useNearWorkViewport';
import { useWorkCardDescription, type WorkCardDescription, workVideoDemo } from './useWorkCardDescription';
import { useWorkCover } from './useWorkCover';
import { WorkCoverPicture } from './WorkCoverPicture';
import { requestWorkVideoFrame, type WorkVideoFrame } from './work-video-frame';
import { worksPanelCopy } from './works-panel.shell-copy';

/** Seconds of the fixed version from its probed media clock, so an adopted cover needs no frame read. */
function mediaSeconds(described: WorkCardDescription | null | undefined) {
  const media = (described?.asset as { media?: unknown } | undefined)?.media as
    | { kind?: string; durationTicks?: number; timebase?: { numerator: number; denominator: number } }
    | undefined;
  if (media?.kind !== 'video' || !media.durationTicks || !media.timebase?.denominator) return undefined;
  return (media.durationTicks * media.timebase.numerator) / media.timebase.denominator;
}

export function WorkVideoPreview({
  artifact,
  description,
  pending,
  previewCover,
}: {
  artifact: ThreadArtifactDTO;
  description?: WorkCardDescription | null;
  pending?: boolean;
  /** A picture being considered in the cover picker, shown exactly as the card would show it. */
  previewCover?: string;
}) {
  const { ref, near } = useNearWorkViewport<HTMLSpanElement>({ rootMargin: '0px', once: false });
  const read = useWorkCardDescription(artifact.work, near && description === undefined);
  const described = description ?? read.description;
  const demo = workVideoDemo(described);
  const cover = useWorkCover(artifact.work, near && !pending && !previewCover);
  const adopted =
    cover.view?.state === 'image' && cover.view.image ? resolveAssetUrl(cover.view.image.url, API_URL) : undefined;
  // An adopted picture wins; a cleared or unreadable choice shows a real frame, never another picture.
  const poster = previewCover ?? adopted ?? (cover.view && cover.view.state !== 'none' ? undefined : demo?.poster);
  const url = resolveAssetUrl(artifact.url, API_URL);
  const t = useShellCopy(worksPanelCopy);
  const settled = !!previewCover || !artifact.work || !cover.loading;
  return (
    <span ref={ref} className="work-cover work-cover-video">
      <VideoFrame
        key={`${url}:${poster ?? ''}`}
        url={url}
        poster={poster}
        duration={demo?.durationSeconds ?? mediaSeconds(described)}
        enabled={near && (description !== undefined || !read.loading) && !pending && settled}
        label={t.filters.video}
      />
    </span>
  );
}

function VideoFrame({
  url,
  poster,
  duration,
  enabled,
  label,
}: {
  url?: string;
  poster?: string;
  duration?: number;
  enabled: boolean;
  label: string;
}) {
  const [frame, setFrame] = useState<WorkVideoFrame | null>(null);
  const [posterFailed, setPosterFailed] = useState(false);
  const cover = poster && !posterFailed ? poster : undefined;
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!enabled || !url || cover || frame) return;
    return requestWorkVideoFrame(url, setFrame);
  }, [enabled, url, cover, frame]);
  useEffect(() => {
    if (!frame || !canvas.current) return;
    canvas.current.width = frame.canvas.width;
    canvas.current.height = frame.canvas.height;
    canvas.current.getContext('2d')?.drawImage(frame.canvas, 0, 0);
  }, [frame]);
  const seconds = frame?.duration ?? duration;
  const time =
    seconds !== undefined && Number.isFinite(seconds) && seconds > 0
      ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
      : label;
  return (
    <>
      {frame && <canvas ref={canvas} className="work-cover-frame" aria-hidden="true" tabIndex={-1} />}
      {cover && enabled && <WorkCoverPicture src={cover} onError={() => setPosterFailed(true)} />}
      {!cover && !frame && (
        <span className="work-cover-play">
          <ShellGlyph name="play" className="h-5 w-5" />
        </span>
      )}
      <span className="work-cover-badge work-cover-video-badge">
        <ShellGlyph name="play" className="h-3 w-3" />
        {time}
      </span>
    </>
  );
}
