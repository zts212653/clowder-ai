import type { ArtifactReviewAnchor, ImmutableMedia } from '@cat-cafe/shared';
import { anchorBounds } from './review-geometry';

export interface PendingChatMark {
  readonly id: string;
  readonly anchor: ArtifactReviewAnchor;
  readonly label?: string;
  readonly active?: boolean;
}

function thumbnailBadgeCenter(position: number, extent: number, radius: number, fitted: boolean) {
  return fitted ? Math.min(extent - radius, Math.max(radius, position)) : position;
}

/**
 * The places already put into the chat composer, marked on the picture with the number each one has in its chip. They
 * are not saved annotations (those keep their own numbering and discussion), so they look different: a dashed outline
 * and a filled number badge. Like the chips they go away when the message is sent or the place is removed.
 */
export function ReviewPendingChatMarks({
  marks,
  media,
  badgeRadius,
  preview = false,
}: {
  marks: readonly PendingChatMark[];
  media: ImmutableMedia;
  badgeRadius?: number;
  preview?: boolean;
}) {
  const radius = badgeRadius ?? Math.max(8, media.width / 65);
  return (
    <>
      {marks.map((mark, index) => {
        const box = anchorBounds(mark.anchor);
        if (!box) return null;
        const isPoint = mark.anchor.kind === 'image-point' || (preview && box.width === 0 && box.height === 0);
        const fitted = badgeRadius !== undefined;
        const cx = thumbnailBadgeCenter(isPoint ? box.x : box.x + radius, media.width, radius, fitted);
        const cy = thumbnailBadgeCenter(isPoint ? box.y : box.y + radius, media.height, radius, fitted);
        return (
          <g
            key={mark.id}
            data-testid="review-pending-chat-mark"
            data-selection-id={mark.id}
            data-active={mark.active || undefined}
            tabIndex={mark.active ? 0 : undefined}
            aria-label={mark.active ? `第 ${mark.label ?? index + 1} 处` : undefined}
          >
            {isPoint ? null : (
              <rect
                x={box.x}
                y={box.y}
                width={box.width}
                height={box.height}
                fill="var(--cafe-accent)"
                fillOpacity={mark.active ? 0.25 : 0.1}
                stroke="var(--cafe-accent)"
                strokeWidth={preview ? 1.5 : 2}
                strokeDasharray={preview ? '3 2' : mark.active ? undefined : '6 4'}
                vectorEffect="non-scaling-stroke"
              />
            )}
            {preview && isPoint ? (
              <circle
                cx={box.x}
                cy={box.y}
                r={(media.width / 40) * 2}
                fill="none"
                stroke="var(--cafe-accent)"
                strokeWidth={1.5}
                strokeDasharray="3 2"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
            {!preview ? (
              <>
                <circle
                  cx={cx}
                  cy={cy}
                  r={radius}
                  fill="var(--cafe-accent)"
                  stroke="var(--cafe-surface)"
                  strokeWidth={2}
                />
                <text
                  x={cx}
                  y={cy}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="var(--cafe-surface)"
                  fontSize={Math.max(11, radius * 1.2)}
                  fontWeight={600}
                >
                  {mark.label ?? index + 1}
                </text>
              </>
            ) : null}
          </g>
        );
      })}
    </>
  );
}
