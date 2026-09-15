import type { ArtifactReviewAnchor, ImmutableMedia } from '@cat-cafe/shared';
import { type CSSProperties, type ReactNode, type RefObject, useLayoutEffect, useState } from 'react';
import { ReviewToolbarIcon } from './ReviewToolbarIcon';
import styles from './review-comment.module.css';
import { anchorBounds } from './review-geometry';
import toolbar from './review-toolbar.module.css';

export function ReviewCanvasPopover({
  anchor,
  media,
  canvasRef,
  containerRef,
  onClose,
  children,
}: {
  anchor: ArtifactReviewAnchor;
  media: ImmutableMedia;
  canvasRef: RefObject<HTMLDivElement>;
  containerRef: RefObject<HTMLDivElement>;
  onClose: () => void;
  children: ReactNode;
}) {
  const [position, setPosition] = useState<CSSProperties>({
    '--comment-left': '12px',
    '--comment-top': '104px',
  } as CSSProperties);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const place = () => {
      const box = canvas.getBoundingClientRect();
      const host = container.getBoundingClientRect();
      const region = anchorBounds(anchor) ?? { x: media.width / 2, y: media.height / 2, width: 0, height: 0 };
      const scale = Math.min(box.width / media.width, box.height / media.height);
      const x = box.x - host.x + (box.width - media.width * scale) / 2 + region.x * scale;
      const y = box.y - host.y + (box.height - media.height * scale) / 2 + region.y * scale;
      const after = x + region.width * scale + 14;
      const left = after + 320 <= host.width - 12 ? after : x - 334;
      const top = host.width <= 600 ? y + region.height * scale + 14 : y;
      setPosition({
        '--comment-left': `${Math.max(12, Math.min(left, host.width - 332))}px`,
        '--comment-top': `${Math.max(104, Math.min(top, host.height - 208))}px`,
      } as CSSProperties);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [anchor, canvasRef, containerRef, media.width, media.height]);
  return (
    <div
      className={styles.popover}
      role="dialog"
      aria-label="评论这处画面"
      style={position}
      data-testid="review-comment-popover"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className={styles.popoverHeading}>
        <span className="flex items-center gap-2">
          <ReviewToolbarIcon name="comment" />
          这处想怎样调整？
        </span>
        <button type="button" className={toolbar.iconButton} aria-label="收起评论草稿" onClick={onClose}>
          <ReviewToolbarIcon name="close" />
        </button>
      </div>
      {children}
    </div>
  );
}
