'use client';
import type { ImmutableMedia } from '@cat-cafe/shared';
import { type PointerEvent, useCallback, useEffect, useRef, useState } from 'react';
import typographyTokens from '@/styles/typography-tokens.json';
import { MarkupShape, Stroke } from './ReviewMarkupShapes';
import { type MediaPoint, pointInMedia, regionBetween } from './review-geometry';
import {
  MAX_STROKE_POINTS,
  type ReviewMarkupFrame,
  type ReviewMarkupMark,
  type ReviewMarkupTool,
} from './review-markup-draft';

type Preview = Exclude<ReviewMarkupMark, { kind: 'stroke' }>;
type ShapeTool = Extract<ReviewMarkupTool, 'rectangle' | 'ellipse' | 'arrow'>;

function isShapeTool(tool: ReviewMarkupTool): tool is ShapeTool {
  return tool === 'rectangle' || tool === 'ellipse' || tool === 'arrow';
}

export function ReviewMarkupLayer({
  media,
  marks,
  drawingKey,
  selectedId,
  frame,
  canAdd,
  tool,
  color,
  strokeWidth,
  text,
  onAdd,
  onSelect,
  onRemove,
  onTextRequired,
  onNotice,
  onDrawStart,
  savedMarkIds = [],
}: {
  media: Pick<ImmutableMedia, 'width' | 'height'>;
  marks: ReviewMarkupMark[];
  drawingKey: string;
  selectedId: string | null;
  frame?: ReviewMarkupFrame | null;
  canAdd: boolean;
  tool: ReviewMarkupTool;
  color: ReviewMarkupMark['color'];
  strokeWidth: ReviewMarkupMark['strokeWidth'];
  text: string;
  onAdd: (mark: ReviewMarkupMark) => void;
  onSelect: (id: string | null) => void;
  onRemove: (id: string) => void;
  onTextRequired: () => void;
  onNotice: (kind: 'frame' | 'stroke-limit' | 'mark-limit') => void;
  onDrawStart: () => void;
  savedMarkIds?: string[];
}) {
  const start = useRef<MediaPoint | null>(null);
  const drawingPointer = useRef<{
    target: SVGSVGElement;
    pointerId: number;
    identity: string;
    tool: ReviewMarkupTool;
  } | null>(null);
  const stroke = useRef<MediaPoint[]>([]);
  const strokeFrame = useRef<ReviewMarkupFrame | undefined>(undefined);
  const strokeAtLimit = useRef(false);
  const [strokePreview, setStrokePreview] = useState<MediaPoint[]>([]);
  const [shapePreview, setShapePreview] = useState<Preview | null>(null);
  const drawingIdentity = `${drawingKey}:${media.width}:${media.height}:${
    frame === undefined ? 'image' : frame === null ? 'frame-unavailable' : `${frame.streamId}:${frame.tick}`
  }`;
  const point = (event: PointerEvent<SVGSVGElement>, clamp = false) =>
    pointInMedia({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect(), media, clamp);
  const releaseDrawing = useCallback(() => {
    const captured = drawingPointer.current;
    drawingPointer.current = null;
    start.current = null;
    stroke.current = [];
    strokeFrame.current = undefined;
    strokeAtLimit.current = false;
    if (captured?.target.hasPointerCapture(captured.pointerId))
      captured.target.releasePointerCapture(captured.pointerId);
  }, []);
  const reset = useCallback(() => {
    releaseDrawing();
    setStrokePreview([]);
    setShapePreview(null);
  }, [releaseDrawing]);
  useEffect(() => {
    reset();
    return releaseDrawing;
  }, [drawingIdentity, tool, color, strokeWidth, text, canAdd, reset, releaseDrawing]);
  const create = (kind: ShapeTool, from: MediaPoint, to: MediaPoint): Preview | null => {
    const id = crypto.randomUUID();
    if (kind === 'arrow') {
      if (Math.hypot(to.x - from.x, to.y - from.y) < 1) return null;
      return { id, kind, from, to, color, strokeWidth };
    }
    const region = regionBetween(from, to);
    if (!region) return null;
    const { x, y, width, height } = region;
    return { id, kind, x, y, width, height, color, strokeWidth };
  };
  const add = (mark: ReviewMarkupMark) => onAdd(strokeFrame.current ? { ...mark, frame: strokeFrame.current } : mark);
  const ownsDrawing = (event: PointerEvent<SVGSVGElement>) => {
    const captured = drawingPointer.current;
    return (
      captured?.target === event.currentTarget &&
      captured.pointerId === event.pointerId &&
      captured.identity === drawingIdentity &&
      captured.tool === tool
    );
  };
  const finish = (event: PointerEvent<SVGSVGElement>) => {
    const captured = drawingPointer.current;
    if (!captured || captured.target !== event.currentTarget || captured.pointerId !== event.pointerId) return;
    if (!ownsDrawing(event) || !canAdd) return reset();
    const from = start.current;
    const to = point(event, true);
    if (tool === 'brush' && stroke.current.length >= 2)
      add({ id: crypto.randomUUID(), kind: 'stroke', points: stroke.current, color, strokeWidth });
    else if (from && to && isShapeTool(tool)) {
      const mark = create(tool, from, to);
      if (mark) add(mark);
    }
    reset();
  };
  const cancelPointer = (event: PointerEvent<SVGSVGElement>) => {
    const captured = drawingPointer.current;
    if (captured?.target === event.currentTarget && captured.pointerId === event.pointerId) reset();
  };
  const interactWithMark = (id: string) => {
    if (tool === 'eraser') onRemove(id);
    else onSelect(id);
  };
  const extendStroke = (at: MediaPoint) => {
    const last = stroke.current.at(-1);
    if (last && Math.hypot(at.x - last.x, at.y - last.y) < 0.5) return;
    if (stroke.current.length >= MAX_STROKE_POINTS) {
      if (!strokeAtLimit.current) onNotice('stroke-limit');
      strokeAtLimit.current = true;
      return;
    }
    stroke.current = [...stroke.current, at];
    setStrokePreview(stroke.current);
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const captured = drawingPointer.current;
    if (!captured || captured.target !== event.currentTarget || captured.pointerId !== event.pointerId) return;
    if (!ownsDrawing(event) || !canAdd) return reset();
    if (!start.current) return;
    const at = point(event, true);
    if (!at) return;
    if (tool === 'brush') {
      extendStroke(at);
      return;
    }
    if (isShapeTool(tool)) setShapePreview(create(tool, start.current, at));
  };
  return (
    <svg
      data-testid="review-markup-layer"
      viewBox={`0 0 ${media.width} ${media.height}`}
      aria-label="标注画布"
      className="absolute inset-0 h-full w-full touch-none cursor-crosshair"
      onPointerDown={(event) => {
        const at = point(event);
        if (!at || drawingPointer.current || tool === 'select' || tool === 'eraser') return;
        if (!canAdd) {
          onNotice('mark-limit');
          return;
        }
        if (frame === null) {
          onNotice('frame');
          return;
        }
        onDrawStart();
        strokeFrame.current = frame;
        if (tool === 'text') {
          if (!text.trim()) onTextRequired();
          // Snapshot the authoring default as a number in media space; saved marks never read live UI CSS sizes.
          else
            add({
              id: crypto.randomUUID(),
              kind: 'text',
              at,
              text: text.trim(),
              color,
              strokeWidth,
              fontSize: typographyTokens.fontSizePx.lg,
            });
          return;
        }
        start.current = at;
        stroke.current = tool === 'brush' ? [at] : [];
        if (tool === 'brush') setStrokePreview([at]);
        event.currentTarget.setPointerCapture(event.pointerId);
        drawingPointer.current = {
          target: event.currentTarget,
          pointerId: event.pointerId,
          identity: drawingIdentity,
          tool,
        };
      }}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={cancelPointer}
      onLostPointerCapture={cancelPointer}
    >
      <title>画出你的想法，保存后伙伴可见；撤销只影响未提交的笔画</title>
      {marks
        .filter(
          (mark) => !mark.frame || (frame && mark.frame.streamId === frame.streamId && mark.frame.tick === frame.tick),
        )
        .map((mark, index) => (
          <MarkupShape
            key={mark.id}
            mark={mark}
            active={selectedId === mark.id}
            label={`${savedMarkIds.includes(mark.id) ? '已保存标记' : '本地草稿'} ${index + 1}`}
            saved={savedMarkIds.includes(mark.id)}
            onInteract={() => interactWithMark(mark.id)}
          />
        ))}
      {strokePreview.length > 1 ? (
        <Stroke points={strokePreview} color={color} strokeWidth={strokeWidth} opacity={0.65} />
      ) : null}
      {shapePreview ? <MarkupShape mark={shapePreview} active={false} label="正在绘制" opacity={0.65} /> : null}
    </svg>
  );
}
