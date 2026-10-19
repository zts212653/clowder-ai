'use client';
import type { MediaContextAttachment } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { mediaAttachmentUrl } from './media-attachment-owner';
import { ReviewPendingChatMarks } from './ReviewPendingChatMarks';

export function MediaAttachmentThumbnail({
  attachment,
  compact = false,
}: {
  attachment: MediaContextAttachment;
  compact?: boolean;
}) {
  const src = mediaAttachmentUrl(attachment);
  const imageRef = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [renderedWidth, setRenderedWidth] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const image = imageRef.current;
    if (!src || failed || compact || !image || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setRenderedWidth(image.getBoundingClientRect().width));
    observer.observe(image);
    return () => observer.disconnect();
  }, [src, failed, compact]);
  if (!src || failed) return <span className="text-micro text-cafe-muted">{attachment.title}</span>;
  return (
    <span
      className="relative block max-w-full overflow-hidden rounded-md bg-cafe-surface-sunken"
      style={{ width: size ? Math.min(256, (144 * size.width) / size.height) : undefined }}
      aria-hidden="true"
    >
      {attachment.mediaType === 'video/mp4' ? (
        <video src={src} muted preload="metadata" className="max-h-36 max-w-full" onError={() => setFailed(true)} />
      ) : (
        /* biome-ignore lint/performance/noImgElement: authenticated owner media must retain its exact version URL */
        <img
          ref={imageRef}
          src={src}
          alt=""
          className="block max-h-36 max-w-full"
          onError={() => setFailed(true)}
          onLoad={(event) => {
            const image = event.currentTarget;
            setSize({ width: image.naturalWidth, height: image.naturalHeight });
            setRenderedWidth(image.getBoundingClientRect().width);
          }}
        />
      )}
      {size ? (
        <svg
          viewBox={`0 0 ${size.width} ${size.height}`}
          className="pointer-events-none absolute inset-0 h-full w-full"
        >
          <ReviewPendingChatMarks
            media={{ kind: 'image', ...size }}
            badgeRadius={!compact && renderedWidth > 0 ? (9 * size.width) / renderedWidth : undefined}
            marks={attachment.selections.map((item) => ({ id: item.id, label: item.id, anchor: item.selection }))}
          />
        </svg>
      ) : null}
    </span>
  );
}
