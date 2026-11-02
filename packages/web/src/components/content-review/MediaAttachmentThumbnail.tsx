'use client';
import type { ImmutableMedia, MediaContextAttachment } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { useShellLanguage } from '@/components/shell/shell-language';
import { mediaAttachmentUrl } from './media-attachment-owner';
import styles from './media-selection-preview.module.css';
import { ReviewPendingChatMarks } from './ReviewPendingChatMarks';
import { selectionPreviewSeconds } from './useMediaAttachmentPreview';

type Props = {
  attachment: MediaContextAttachment;
  compact?: boolean;
  item?: MediaContextAttachment['selections'][number];
  media?: ImmutableMedia;
  expanded?: boolean;
};
export function MediaAttachmentThumbnail(props: Props) {
  // A different original/frame resets readiness before old pixels can be shown with new marks.
  return <Thumbnail key={JSON.stringify([mediaAttachmentUrl(props.attachment), props.item?.selection])} {...props} />;
}
function Thumbnail({ attachment, item, media, expanded = false }: Props) {
  const english = useShellLanguage() === 'en';
  const src = mediaAttachmentUrl(attachment);
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const video = attachment.mediaType === 'video/mp4';
  const seconds = item ? selectionPreviewSeconds(item.selection, media) : 0;
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const available = src && !failed && (!video || seconds !== null);
  const decoded = (node: HTMLVideoElement) => {
    if (
      !node.seeking &&
      node.readyState >= 2 &&
      node.videoWidth > 0 &&
      node.videoHeight > 0 &&
      Math.abs(node.currentTime - (seconds ?? 0)) < 0.05
    ) {
      // Selection coordinates belong to the owner's display plane, which can differ from coded/native pixels.
      setSize(
        media?.kind === 'video'
          ? { width: media.width, height: media.height }
          : { width: node.videoWidth, height: node.videoHeight },
      );
      setReady(true);
    }
  };
  return (
    <span
      ref={ref}
      data-testid="media-selection-preview"
      data-preview-ready={ready || undefined}
      className={
        item
          ? `${styles.thumbnail} ${expanded ? styles.expanded : ''}`
          : 'relative block max-w-full overflow-hidden rounded-md bg-cafe-surface-sunken'
      }
      aria-hidden="true"
    >
      {available && visible ? (
        video ? (
          <video
            src={src}
            muted
            playsInline
            preload="metadata"
            className={styles.pixels}
            style={{ opacity: ready ? 1 : 0 }}
            onError={() => setFailed(true)}
            onLoadedMetadata={(event) => {
              event.currentTarget.currentTime = seconds ?? 0;
              decoded(event.currentTarget);
            }}
            onLoadedData={(event) => decoded(event.currentTarget)}
            onSeeked={(event) => decoded(event.currentTarget)}
          />
        ) : (
          /* biome-ignore lint/performance/noImgElement: preserve the authenticated original owner's exact version URL */
          <img
            src={src}
            alt=""
            className={item ? styles.pixels : 'block max-h-36 max-w-full'}
            onError={() => setFailed(true)}
            onLoad={(event) => {
              setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
              setReady(true);
            }}
          />
        )
      ) : null}
      {ready && size ? (
        <svg
          viewBox={`0 0 ${size.width} ${size.height}`}
          className="pointer-events-none absolute inset-0 h-full w-full"
          preserveAspectRatio="xMidYMid meet"
        >
          <ReviewPendingChatMarks
            media={{ kind: 'image', ...size }}
            preview={!!item}
            marks={(item ? [item] : attachment.selections).map((place) => ({
              id: place.id,
              label: place.id,
              anchor: place.selection,
            }))}
          />
        </svg>
      ) : null}
      {!available ? <span className={styles.unavailable}>{english ? 'Preview unavailable' : '预览不可用'}</span> : null}
    </span>
  );
}
