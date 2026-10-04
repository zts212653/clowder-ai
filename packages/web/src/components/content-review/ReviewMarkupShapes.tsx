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
  mediaWidth,
  mediaHeight,
}: {
  mark: ReviewMarkupMark;
  active: boolean;
  label: string;
  opacity?: number;
  onInteract?: () => void;
  saved?: boolean;
  mediaWidth: number;
  mediaHeight: number;
}) {
  const textLayout = mark.kind === 'text' ? layoutArtworkText(mark, mediaWidth, mediaHeight) : null;
  const bounds = active ? shapeBounds(mark, textLayout) : null;
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
      {mark.kind === 'text' && textLayout ? <MarkupText mark={mark} layout={textLayout} /> : null}
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

function MarkupText({
  mark,
  layout,
}: {
  mark: Extract<ReviewMarkupMark, { kind: 'text' }>;
  layout: ArtworkTextLayout;
}) {
  return (
    <text
      x={layout.x}
      y={layout.y}
      fill={mark.color}
      fontSize={layout.fontSize}
      stroke="var(--cafe-surface-canvas)"
      strokeWidth={Math.max(1, layout.fontSize * 0.15)}
      paintOrder="stroke fill"
      style={{ pointerEvents: 'visiblePainted' }}
    >
      {layout.lines.map((line, index) => (
        <tspan key={index} x={layout.x} dy={index ? layout.fontSize * 1.25 : 0}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

type ArtworkTextLayout = {
  lines: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
};

function layoutArtworkText(
  mark: Extract<ReviewMarkupMark, { kind: 'text' }>,
  mediaWidth: number,
  mediaHeight: number,
): ArtworkTextLayout {
  const margin = Math.min(mark.fontSize / 2, mediaWidth / 40, mediaHeight / 40);
  const maxWidth = mediaWidth - margin * 2;
  const maxHeight = mediaHeight - margin * 2;
  let fontSize = Math.min(mark.fontSize, maxWidth);
  let available = Math.min(maxWidth, Math.max(mediaWidth * 0.85, mediaWidth - mark.at.x - margin));
  // Reserve most of a narrow portrait instead of stacking text into a tall
  // column. The line may start left of its anchor near the right edge.
  const characterWidth = (character: string) => fontSize * (/[^\u0000-\u00ff]/.test(character) ? 1 : 0.85);
  const wrap = () => wrapArtworkText(mark.text, available, characterWidth);
  let lines = wrap();
  while (lines.length * fontSize * 1.25 > maxHeight && available < maxWidth) {
    available = Math.min(maxWidth, Math.max(available * 1.25, available + fontSize));
    lines = wrap();
  }
  if (lines.length * fontSize * 1.25 > maxHeight) {
    fontSize = Math.min(fontSize, maxHeight / (lines.length * 1.25));
    lines = wrap();
  }
  const width = Math.max(
    fontSize,
    ...lines.map((line) => Array.from(line).reduce((sum, character) => sum + characterWidth(character), 0)),
  );
  const height = (lines.length - 1) * fontSize * 1.25 + fontSize * 1.25;
  const x = Math.max(margin, Math.min(mark.at.x, mediaWidth - margin - width));
  const y = Math.max(margin + fontSize, Math.min(mark.at.y, mediaHeight - margin - height + fontSize));
  return { lines, x, y, width, height, fontSize };
}

function wrapArtworkText(text: string, available: number, characterWidth: (character: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '',
      width = 0;
    const nextLine = () => {
      lines.push(line.trimEnd());
      line = '';
      width = 0;
    };
    for (const token of paragraph.match(/[A-Za-z0-9]+[ \t]*|./gu) ?? []) {
      const segment = line ? token : token.trimStart();
      const segmentWidth = Array.from(segment).reduce((sum, character) => sum + characterWidth(character), 0);
      if (line && width + segmentWidth > available) nextLine();
      if (segmentWidth > available) {
        for (const character of segment.trimStart()) {
          const size = characterWidth(character);
          if (line && width + size > available) nextLine();
          line += character;
          width += size;
        }
      } else {
        const addition = line ? segment : segment.trimStart();
        line += addition;
        width += Array.from(addition).reduce((sum, character) => sum + characterWidth(character), 0);
      }
    }
    nextLine();
  }
  return lines;
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

function shapeBounds(mark: ReviewMarkupMark, textLayout: ArtworkTextLayout | null) {
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
        x: textLayout?.x ?? mark.at.x,
        y: textLayout ? textLayout.y - textLayout.fontSize : mark.at.y - mark.fontSize,
        width: textLayout?.width ?? 1,
        height: textLayout?.height ?? mark.fontSize,
      };
  }
}
