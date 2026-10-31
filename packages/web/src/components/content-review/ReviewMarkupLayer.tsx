'use client';
import type { ImmutableMedia } from '@cat-cafe/shared';
import { type PointerEvent, useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import typographyTokens from '@/styles/typography-tokens.json';
import { MarkupShape, Stroke } from './ReviewMarkupShapes';
import { type InlineTextDraft, ReviewMarkupTextEditor } from './ReviewMarkupTextEditor';
import { type MediaPoint, pointInMedia, regionBetween } from './review-geometry';
import {
  MAX_STROKE_POINTS,
  type ReviewMarkupFrame,
  type ReviewMarkupMark,
  type ReviewMarkupTool,
} from './review-markup-draft';
import { mediaPixelsForScreenPixels } from './useArtworkViewport';

type Preview = Exclude<ReviewMarkupMark, { kind: 'stroke' }>;
type ShapeTool = Extract<ReviewMarkupTool, 'rectangle' | 'ellipse' | 'arrow'>;
const textEditorStorageSchema = z
  .object({
    v: z.literal(1),
    editor: z
      .object({
        at: z.object({ x: z.number().finite().min(0), y: z.number().finite().min(0) }).strict(),
        value: z.string().max(240),
        originalId: z.string().min(1).max(128).optional(),
        frame: z
          .object({ streamId: z.string().min(1).max(128), tick: z.number().int().safe() })
          .strict()
          .optional(),
        moving: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();
function readTextEditor(key: string, media: Pick<ImmutableMedia, 'width' | 'height'>): InlineTextDraft | null {
  try {
    const stored = localStorage.getItem(`${key}:text-editor`);
    if (!stored) return null;
    const { editor } = textEditorStorageSchema.parse(JSON.parse(stored));
    if (editor.at.x > media.width || editor.at.y > media.height) return null;
    return editor;
  } catch {
    return null;
  }
}

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
  canEdit,
  tool,
  color,
  strokeWidth,
  screenScale = 1,
  onAdd,
  onUpdate,
  onSelect,
  onRemove,
  onTextComplete,
  onEditingChange,
  onNotice,
  onDrawStart,
  savedMarkIds = [],
  lockedMarkIds = [],
}: {
  media: Pick<ImmutableMedia, 'width' | 'height'>;
  marks: ReviewMarkupMark[];
  drawingKey: string;
  selectedId: string | null;
  frame?: ReviewMarkupFrame | null;
  canAdd: boolean;
  canEdit: boolean;
  tool: ReviewMarkupTool;
  color: ReviewMarkupMark['color'];
  strokeWidth: ReviewMarkupMark['strokeWidth'];
  screenScale?: number;
  onAdd: (mark: ReviewMarkupMark) => void;
  onUpdate: (mark: ReviewMarkupMark) => void;
  onSelect: (id: string | null) => void;
  onRemove: (id: string) => void;
  onTextComplete: () => void;
  onEditingChange: (active: boolean) => void;
  onNotice: (kind: 'frame' | 'stroke-limit' | 'mark-limit' | 'pending') => void;
  onDrawStart: () => void;
  savedMarkIds?: string[];
  lockedMarkIds?: string[];
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
  const [editor, setEditor] = useState<InlineTextDraft | null>(() => readTextEditor(drawingKey, media));
  const [textNotice, setTextNotice] = useState<string | null>(null);
  useEffect(() => {
    onEditingChange(Boolean(editor));
    return () => onEditingChange(false);
  }, [editor, onEditingChange]);
  useEffect(() => {
    try {
      if (editor) localStorage.setItem(`${drawingKey}:text-editor`, JSON.stringify({ v: 1, editor }));
      else localStorage.removeItem(`${drawingKey}:text-editor`);
    } catch {
      setTextNotice('文字草稿暂时无法写入浏览器，请保留页面。');
    }
  }, [drawingKey, editor]);
  const mediaStroke = mediaPixelsForScreenPixels(strokeWidth, screenScale);
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
  }, [drawingIdentity, tool, color, strokeWidth, canAdd, reset, releaseDrawing]);
  const create = (kind: ShapeTool, from: MediaPoint, to: MediaPoint): Preview | null => {
    const id = crypto.randomUUID();
    if (kind === 'arrow') {
      if (Math.hypot(to.x - from.x, to.y - from.y) < 1) return null;
      return { id, kind, from, to, color, strokeWidth: mediaStroke };
    }
    const region = regionBetween(from, to);
    if (!region) return null;
    const { x, y, width, height } = region;
    return { id, kind, x, y, width, height, color, strokeWidth: mediaStroke };
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
      add({ id: crypto.randomUUID(), kind: 'stroke', points: stroke.current, color, strokeWidth: mediaStroke });
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
    if (lockedMarkIds.includes(id)) {
      onNotice('pending');
      return;
    }
    if (tool === 'eraser') onRemove(id);
    else {
      onSelect(id);
      const mark = marks.find((item) => item.id === id);
      if (canEdit && mark?.kind === 'text' && !savedMarkIds.includes(id))
        setEditor({ at: mark.at, value: mark.text, originalId: id, ...(mark.frame ? { frame: mark.frame } : {}) });
    }
  };
  const finishText = () => {
    if (!editor) return;
    const value = editor.value.trim();
    const original = editor.originalId ? marks.find((mark) => mark.id === editor.originalId) : null;
    const editableOriginal = original?.kind === 'text' ? original : null;
    const originalWasSaved = Boolean(editableOriginal && savedMarkIds.includes(editableOriginal.id));
    if (value && !(editableOriginal && !originalWasSaved ? canEdit : canAdd)) {
      setTextNotice('当前无法完成文字，草稿仍保留。');
      return;
    }
    if (
      value &&
      (!originalWasSaved ||
        editableOriginal?.text !== value ||
        editableOriginal.at.x !== editor.at.x ||
        editableOriginal.at.y !== editor.at.y)
    ) {
      const mark: ReviewMarkupMark = editableOriginal
        ? {
            ...editableOriginal,
            id: originalWasSaved ? crypto.randomUUID() : editableOriginal.id,
            at: editor.at,
            text: value,
          }
        : {
            id: crypto.randomUUID(),
            kind: 'text',
            at: editor.at,
            text: value,
            color,
            strokeWidth: mediaStroke,
            fontSize: mediaPixelsForScreenPixels(typographyTokens.fontSizePx.lg, screenScale),
            ...(editor.frame ? { frame: editor.frame } : {}),
          };
      if (editableOriginal && !originalWasSaved) onUpdate(mark);
      else onAdd(mark);
    }
    setEditor(null);
    setTextNotice(null);
    onTextComplete();
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
    <>
      <svg
        data-testid="review-markup-layer"
        viewBox={`0 0 ${media.width} ${media.height}`}
        aria-label="标注画布"
        className="absolute inset-0 h-full w-full touch-none cursor-crosshair"
        onPointerDown={(event) => {
          const at = point(event);
          if (!at || drawingPointer.current) return;
          if (editor?.moving) {
            setEditor({ ...editor, at, moving: false });
            return;
          }
          if (tool === 'select' || tool === 'eraser') return;
          if (tool === 'text' && editor) return;
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
            setEditor({ at, value: '', ...(frame ? { frame } : {}) });
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
        {marks
          .filter(
            (mark) =>
              !mark.frame || (frame && mark.frame.streamId === frame.streamId && mark.frame.tick === frame.tick),
          )
          .map((mark, index) => (
            <MarkupShape
              key={mark.id}
              mark={mark}
              active={selectedId === mark.id}
              label={`${savedMarkIds.includes(mark.id) ? '已保存标记' : '本地草稿'} ${index + 1}`}
              saved={savedMarkIds.includes(mark.id)}
              onInteract={() => interactWithMark(mark.id)}
              mediaWidth={media.width}
              mediaHeight={media.height}
            />
          ))}
        {strokePreview.length > 1 ? (
          <Stroke points={strokePreview} color={color} strokeWidth={mediaStroke} opacity={0.65} />
        ) : null}
        {shapePreview ? (
          <MarkupShape
            mark={shapePreview}
            active={false}
            label="正在绘制"
            opacity={0.65}
            mediaWidth={media.width}
            mediaHeight={media.height}
          />
        ) : null}
      </svg>
      {editor ? (
        <ReviewMarkupTextEditor
          editor={editor}
          media={media}
          screenScale={screenScale}
          notice={textNotice}
          onChange={setEditor}
          onComplete={finishText}
          onNotice={setTextNotice}
        />
      ) : null}
    </>
  );
}
