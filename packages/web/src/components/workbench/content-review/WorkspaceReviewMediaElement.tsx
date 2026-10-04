import type { ImmutableMedia } from '@cat-cafe/shared';
import Image from 'next/image';
import type { RefObject } from 'react';

export function WorkspaceReviewMediaElement({
  src,
  error,
  media,
  video,
  selectionActive,
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
  onSeeking: () => void;
  onSeeked: () => void;
  onSeconds: (seconds: number) => void;
  onError: (error: string) => void;
}) {
  if (!src) return <p className="p-4 text-sm text-cafe-muted">{error ?? '正在核对并读取原版媒体…'}</p>;
  if (media.kind === 'image')
    return (
      <Image
        src={src}
        alt="正在批注的作品"
        width={media.width}
        height={media.height}
        unoptimized
        className="absolute inset-0 h-full w-full object-contain"
        data-testid="workspace-content-review-media"
        onError={() => onError('此浏览器无法显示这张图片，请重新读取或下载原文件查看。')}
      />
    );
  return (
    // biome-ignore lint/a11y/useMediaCaption: The source owner supplies real tracks; no invented captions.
    <video
      ref={video}
      controls={!selectionActive}
      playsInline
      src={src}
      className="absolute inset-0 h-full w-full object-contain"
      data-testid="workspace-content-review-media"
      onSeeking={onSeeking}
      onSeeked={onSeeked}
      onTimeUpdate={(event) => onSeconds(event.currentTarget.currentTime)}
      onError={() => onError('此浏览器无法播放这份视频，请重新读取或下载原文件查看。')}
    >
      浏览器不支持视频播放
    </video>
  );
}
