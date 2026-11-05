export interface RectLike {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface FloatingSelectionPosition {
  top: number;
  left: number;
}

interface OffsetRange {
  from: number;
  to: number;
}

interface SelectionOffsets extends OffsetRange {
  head: number;
}

const ACTION_WIDTH = 112;
const ACTION_HEIGHT = 32;
const GAP = 8;
const MARGIN = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Translate viewport-space selection geometry into viewer-local action coordinates. */
export function positionSelectionAction(anchor: RectLike, viewport: RectLike): FloatingSelectionPosition | null {
  if (
    anchor.bottom < viewport.top ||
    anchor.top > viewport.bottom ||
    anchor.right < viewport.left ||
    anchor.left > viewport.right
  ) {
    return null;
  }

  const viewportWidth = viewport.width || viewport.right - viewport.left;
  const viewportHeight = viewport.height || viewport.bottom - viewport.top;
  const above = anchor.top - viewport.top - ACTION_HEIGHT - GAP;
  const below = anchor.bottom - viewport.top + GAP;
  const top = above >= MARGIN ? above : clamp(below, MARGIN, viewportHeight - ACTION_HEIGHT - MARGIN);
  const left = clamp(anchor.right - viewport.left - ACTION_WIDTH, MARGIN, viewportWidth - ACTION_WIDTH - MARGIN);

  return { top: Math.round(top), left: Math.round(left) };
}

/** Pick the first selected fragment that is actually visible in the viewer. */
export function positionSelectionActionForAnchors(
  anchors: readonly RectLike[],
  viewport: RectLike,
): FloatingSelectionPosition | null {
  for (const anchor of anchors) {
    const position = positionSelectionAction(anchor, viewport);
    if (position) return position;
  }
  return null;
}

/**
 * Return the selection head first, followed by positions inside every visible
 * selection fragment ordered from nearest to farthest from that head.
 */
export function selectionAnchorPositions(selection: SelectionOffsets, visibleRanges: readonly OffsetRange[]): number[] {
  const visiblePositions = visibleRanges
    .map((range) => selectionOffsetInRange(selection, range))
    .filter((position): position is number => position !== null)
    .sort((a, b) => Math.abs(a - selection.head) - Math.abs(b - selection.head));

  return Array.from(new Set([selection.head, ...visiblePositions]));
}

/**
 * Return one selected candidate for every rendered row in the viewport.
 *
 * CodeMirror's `visibleRanges` may merge several lines into one document
 * range. Callers must pass `viewportLineBlocks` here so a horizontally hidden
 * selection head cannot mask selected text on another visible row.
 */
export function selectionAnchorPositionsForRows(
  selection: SelectionOffsets,
  viewportRows: readonly OffsetRange[],
): number[] {
  return selectionAnchorPositions(selection, viewportRows);
}

/** Choose the selected document offset nearest the head inside a visible document range. */
export function selectionOffsetInRange(selection: SelectionOffsets, visibleRange: OffsetRange): number | null {
  const from = Math.max(selection.from, visibleRange.from);
  const to = Math.min(selection.to, visibleRange.to);
  if (from >= to) return null;
  if (selection.head <= from) return from;
  if (selection.head >= to) return to - 1;
  return selection.head;
}
