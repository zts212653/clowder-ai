import type { ArtifactReviewAnchor, ImmutableMedia } from '@cat-cafe/shared';

export type MediaPoint = { x: number; y: number };
export function pointInMedia(
  client: MediaPoint,
  bounds: { left: number; top: number; width: number; height: number },
  media: { width: number; height: number },
  clamp = false,
): MediaPoint | null {
  const scale = Math.min(bounds.width / media.width, bounds.height / media.height);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const x = (client.x - bounds.left - (bounds.width - media.width * scale) / 2) / scale;
  const y = (client.y - bounds.top - (bounds.height - media.height * scale) / 2) / scale;
  if (!clamp && (x < 0 || y < 0 || x > media.width || y > media.height)) return null;
  return { x: Math.max(0, Math.min(media.width, x)), y: Math.max(0, Math.min(media.height, y)) };
}

export function regionBetween(
  start: MediaPoint,
  end: MediaPoint,
): Extract<ArtifactReviewAnchor, { kind: 'image-region' }> | null {
  const width = Math.abs(end.x - start.x),
    height = Math.abs(end.y - start.y);
  if (width < 1 || height < 1) return null;
  return { kind: 'image-region', x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width, height };
}

type Video = Extract<ImmutableMedia, { kind: 'video' }>;
export function browserTimeToTick(seconds: number, media: Video): number {
  // MP4 mediaTime/currentTime already include the presentation timeline's offset.
  return Math.round((seconds * media.timebase.denominator) / media.timebase.numerator);
}
export function tickToBrowserTime(tick: number, media: Video): number {
  return (tick * media.timebase.numerator) / media.timebase.denominator;
}
export function anchorLabel(anchor: ArtifactReviewAnchor, media: ImmutableMedia): string {
  if (anchor.kind === 'image-point') return `位置 ${Math.round(anchor.x)}, ${Math.round(anchor.y)}`;
  if (anchor.kind === 'image-region')
    return `区域 ${Math.round(anchor.x)}, ${Math.round(anchor.y)} · ${Math.round(anchor.width)} × ${Math.round(anchor.height)}`;
  if (media.kind !== 'video') return '视频标注';
  const start = tickToBrowserTime(anchor.startTick, media).toFixed(2),
    end = tickToBrowserTime(anchor.endTick, media).toFixed(2);
  return `${start}–${end} 秒${anchor.frameRegion ? ' · 画面区域' : anchor.framePoint ? ' · 画面点位' : ''}`;
}

/** Bounds are a view projection; point anchors remain explicitly typed points in persisted records. */
export function anchorBounds(
  anchor: ArtifactReviewAnchor,
): { x: number; y: number; width: number; height: number } | null {
  if (anchor.kind === 'image-region') return anchor;
  if (anchor.kind === 'image-point') return { ...anchor, width: 0, height: 0 };
  if (anchor.frameRegion) return anchor.frameRegion;
  return anchor.framePoint ? { ...anchor.framePoint, width: 0, height: 0 } : null;
}
