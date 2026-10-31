import { EditorView } from 'codemirror';
import {
  type FloatingSelectionPosition,
  positionSelectionActionForAnchors,
  type RectLike,
  selectionAnchorPositionsForRows,
  selectionOffsetInRange,
} from './selection-action-position';

function getSelectionInfo(view: EditorView) {
  const { from, to } = view.state.selection.main;
  if (from === to) return null;
  const text = view.state.sliceDoc(from, to);
  if (!text.trim()) return null;
  const startLine = view.state.doc.lineAt(from).number;
  const endLine = view.state.doc.lineAt(to).number;
  return { text, startLine, endLine, selectionStart: from, selectionEnd: to };
}

export interface CodeSelectionAction {
  position: FloatingSelectionPosition;
  text: string;
  startLine: number;
  endLine: number;
  selectionStart: number;
  selectionEnd: number;
}

function collectSelectionAnchors(view: EditorView): RectLike[] {
  const mainSelection = view.state.selection.main;
  const offsets = selectionAnchorPositionsForRows(mainSelection, view.viewportLineBlocks);
  const editorRect = view.dom.getBoundingClientRect();
  const anchorOffsets = new Set<number>();
  const anchors: RectLike[] = [];
  const addAnchor = (offset: number) => {
    if (anchorOffsets.has(offset)) return null;
    anchorOffsets.add(offset);
    const coords = view.coordsAtPos(offset);
    if (!coords) return null;
    anchors.push({ ...coords, width: coords.right - coords.left, height: coords.bottom - coords.top });
    return coords;
  };

  for (const offset of offsets) {
    const coords = addAnchor(offset);
    if (!coords) continue;
    const visibleTop = Math.max(coords.top, editorRect.top);
    const visibleBottom = Math.min(coords.bottom, editorRect.bottom);
    if (visibleTop >= visibleBottom) continue;
    const y = (visibleTop + visibleBottom) / 2;
    const left = view.posAtCoords({ x: editorRect.left + 1, y });
    const right = view.posAtCoords({ x: editorRect.right - 1, y });
    if (left === null || right === null) continue;
    const visibleOffset = selectionOffsetInRange(mainSelection, {
      from: Math.min(left, right),
      to: Math.max(left, right),
    });
    if (visibleOffset !== null) addAnchor(visibleOffset);
  }
  return anchors;
}

export function selectionActionForView(view: EditorView, shell: HTMLDivElement | null): CodeSelectionAction | null {
  const selection = getSelectionInfo(view);
  if (!shell || !selection) return null;
  const position = positionSelectionActionForAnchors(collectSelectionAnchors(view), shell.getBoundingClientRect());
  return position ? { position, ...selection } : null;
}
