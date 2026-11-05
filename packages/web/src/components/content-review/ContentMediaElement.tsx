import type { ComponentProps, RefObject } from 'react';
import { contentApiBase } from './file-source';

/** The actual media renderer. Owners contribute geometry, playback and annotation controls. */
export function ContentMediaElement({
  kind,
  src,
  title,
  className,
  style,
  width,
  height,
  videoRef,
  onLoad,
  onError,
  videoProps,
  testId,
}: {
  kind: 'image' | 'video' | 'audio';
  src: string;
  title?: string;
  className?: string;
  style?: ComponentProps<'img'>['style'];
  width?: number;
  height?: number;
  videoRef?: RefObject<HTMLVideoElement>;
  onLoad?: ComponentProps<'img'>['onLoad'];
  onError?: () => void;
  videoProps?: Omit<ComponentProps<'video'>, 'src' | 'ref' | 'className' | 'style'>;
  testId?: string;
}) {
  if (kind === 'image')
    return (
      <img
        src={src}
        alt={title ?? ''}
        width={width}
        height={height}
        className={className}
        style={style}
        onLoad={onLoad}
        onError={onError}
        data-testid={testId}
      />
    );
  if (kind === 'audio')
    return (
      <audio src={src} controls className={className} data-testid={testId}>
        浏览器不支持音频播放
      </audio>
    );
  const api = contentApiBase();
  const local = new URL(src, api).origin === api.origin;
  return (
    <video
      {...videoProps}
      src={src}
      ref={videoRef}
      className={className}
      style={style}
      crossOrigin={local ? 'use-credentials' : undefined}
      playsInline
      onError={onError}
      data-testid={testId}
    >
      浏览器不支持视频播放
    </video>
  );
}
