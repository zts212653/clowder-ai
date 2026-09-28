'use client';
import { type KeyboardEvent } from 'react';
import type { ReviewMarkupMark } from './review-markup-draft';

export function MarkupShape({
  mark,
  active,
  label,
  opacity = 1,
  onInteract,
  saved = false,
}: {
  mark: ReviewMarkupMark;
  active: boolean;
  label: string;
  opacity?: number;
  onInteract?: () => void;
  saved?: boolean;
}) {
  const bounds = active ? shapeBounds(mark) : null;
  const content = (
    <>
      {mark.kind === 'stroke' ? <Stroke {...mark} /> : null}
      {mark.kind === 'rectangle' ? (
        <rect {...mark} fill="none" stroke={mark.color} strokeWidth={mark.strokeWidth} />
      ) : null}
      {mark.kind === 'ellipse' ? (
        <ellipse
          cx={mark.x + mark.width / 2}
          cy={mark.y + mark.height / 2}
          rx={mark.width / 2}
          ry={mark.height / 2}
          fill="none"
          stroke={mark.color}
          strokeWidth={mark.strokeWidth}
        />
      ) : null}
      {mark.kind === 'arrow' ? <Arrow {...mark} /> : null}
      {mark.kind === 'text' ? (
        <text x={mark.at.x} y={mark.at.y} fill={mark.color} fontSize={mark.fontSize}>
          {mark.text}
        </text>
      ) : null}
      {bounds ? (
        <rect
          x={bounds.x}
          y={bounds.y}
          width={bounds.width}
          height={bounds.height}
          fill="none"
          stroke="var(--cafe-text)"
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </>
  );
  if (!onInteract)
    return (
      <g data-testid={saved ? 'review-saved-mark' : 'review-local-mark'} data-mark-id={mark.id} opacity={opacity}>
        <title>{label}</title>
        {content}
      </g>
    );
  const keyboard = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onInteract();
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: SVG groups preserve the artwork's native coordinate system; an HTML button cannot be used here.
    <g
      data-testid={saved ? 'review-saved-mark' : 'review-local-mark'}
      data-mark-id={mark.id}
      role="button"
      tabIndex={0}
      aria-label={label}
      className="cursor-pointer focus:outline-none"
      opacity={opacity}
      onClick={onInteract}
      onKeyDown={keyboard}
    >
      {content}
    </g>
  );
}

export function Stroke({
  points,
  color,
  strokeWidth,
  opacity,
}: Pick<Extract<ReviewMarkupMark, { kind: 'stroke' }>, 'points' | 'color' | 'strokeWidth'> & { opacity?: number }) {
  return (
    <polyline
      points={points.map((point) => `${point.x},${point.y}`).join(' ')}
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity={opacity}
    />
  );
}

function Arrow({ from, to, color, strokeWidth }: Extract<ReviewMarkupMark, { kind: 'arrow' }>) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = Math.max(8, strokeWidth * 3);
  const left = { x: to.x - size * Math.cos(angle - Math.PI / 6), y: to.y - size * Math.sin(angle - Math.PI / 6) };
  const right = { x: to.x - size * Math.cos(angle + Math.PI / 6), y: to.y - size * Math.sin(angle + Math.PI / 6) };
  return (
    <>
      <line
        x1={from.x}
        y1={from.y}
        x2={to.x}
        y2={to.y}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <path
        d={`M ${left.x} ${left.y} L ${to.x} ${to.y} L ${right.x} ${right.y}`}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  );
}

function shapeBounds(mark: ReviewMarkupMark) {
  switch (mark.kind) {
    case 'rectangle':
    case 'ellipse':
      return mark;
    case 'stroke': {
      const xs = mark.points.map((point) => point.x),
        ys = mark.points.map((point) => point.y);
      return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      };
    }
    case 'arrow':
      return {
        x: Math.min(mark.from.x, mark.to.x),
        y: Math.min(mark.from.y, mark.to.y),
        width: Math.abs(mark.from.x - mark.to.x),
        height: Math.abs(mark.from.y - mark.to.y),
      };
    case 'text':
      return {
        x: mark.at.x,
        y: mark.at.y - mark.fontSize,
        width: Math.max(mark.text.length * mark.fontSize * 0.6, 1),
        height: mark.fontSize,
      };
  }
}
