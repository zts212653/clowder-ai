'use client';

import { MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V2 } from '@cat-cafe/shared';
import { type RefObject, useEffect, useState } from 'react';
import {
  type FloatingSelectionPosition,
  positionSelectionActionForAnchors,
  type RectLike,
} from '@/components/workspace/selection-action-position';

export interface TextSelectionAction {
  text: string;
  position: FloatingSelectionPosition;
  sourceKind: string | null;
  sourceSegmentId?: string;
  sourceProjectionVersion?: typeof MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V2;
  selectionStart?: number;
  selectionEnd?: number;
  /**
   * How many times these characters appear in the rendered source root. The server cannot
   * compute this: the renderer generates text with no Markdown counterpart (footnote labels,
   * KaTeX glyphs, component loading states). Admission requires 1, so reporting it honestly
   * is what keeps a repeated on-screen fragment from being anchored to the wrong occurrence.
   */
  renderedOccurrences?: number;
}

function rectLike(rect: DOMRect | DOMRectReadOnly): RectLike {
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

function selectionAnchorRects(selection: Selection): RectLike[] {
  if (selection.rangeCount === 0 || typeof selection.getRangeAt !== 'function') return [];
  const range = selection.getRangeAt(0);
  const fragments = Array.from(range.getClientRects());
  if (fragments.length > 0) return fragments.reverse().map(rectLike);
  const rect = range.getBoundingClientRect();
  return rect.width || rect.height ? [rectLike(rect)] : [];
}

function sourceElement(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function selectionOffsets(selection: Selection, container: Node): { start: number; end: number } | null {
  if (selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (typeof range.cloneRange !== 'function') return null;
  try {
    const prefix = range.cloneRange();
    prefix.selectNodeContents(container);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    const end = start + range.toString().length;
    return end > start ? { start, end } : null;
  } catch {
    return null;
  }
}

function rangeSelectsTextWithin(range: Range, candidate: Element): boolean {
  try {
    if (typeof range.intersectsNode !== 'function' || !range.intersectsNode(candidate)) return false;

    const candidateRange = document.createRange();
    candidateRange.selectNodeContents(candidate);
    const overlap = range.cloneRange();
    if (overlap.compareBoundaryPoints(Range.START_TO_START, candidateRange) < 0) {
      overlap.setStart(candidateRange.startContainer, candidateRange.startOffset);
    }
    if (overlap.compareBoundaryPoints(Range.END_TO_END, candidateRange) > 0) {
      overlap.setEnd(candidateRange.endContainer, candidateRange.endOffset);
    }
    return !overlap.collapsed && overlap.toString().trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Interface chrome (action toolbars, annotation markers, component loading/error states) is
 * painted inside the source root but is not message content. Reject selections that actually
 * contain its rendered text. `Range.intersectsNode()` alone is too broad: Chromium also returns
 * true when a drag over the final content line ends in trailing blank space before an icon-only
 * sibling dock, even though `Selection.toString()` contains no chrome.
 */
function crossesExcludedChrome(range: Range, root: Element): boolean {
  const excluded = [
    ...(root.matches('[data-quote-exclude]') ? [root] : []),
    ...Array.from(root.querySelectorAll('[data-quote-exclude]')),
  ];
  return excluded.some((candidate) => rangeSelectsTextWithin(range, candidate));
}

function countRenderedOccurrences(root: Element, text: string): number {
  if (!text) return 0;
  // Selection.toString() follows the rendered layout: block boundaries contribute newlines.
  // textContent flattens those boundaries (for example <p>foo</p><p>foo</p> → "foofoo"),
  // so it cannot attest uniqueness for the exact characters the human selected. innerText is
  // the matching browser plane; textContent remains only for non-layout DOMs such as jsdom.
  const rendered =
    root instanceof HTMLElement && typeof root.innerText === 'string' ? root.innerText : (root.textContent ?? '');
  return rendered.split(text).length - 1;
}

function trimSelectionOffsets(
  offsets: { start: number; end: number } | null,
  rawText: string,
): { start: number; end: number } | null {
  if (!offsets) return null;
  const leadingWhitespaceLength = rawText.length - rawText.trimStart().length;
  const trailingWhitespaceLength = rawText.length - rawText.trimEnd().length;
  return { start: offsets.start + leadingWhitespaceLength, end: offsets.end - trailingWhitespaceLength };
}

function cliProjectionVersion(segment: Element | null): typeof MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V2 | null {
  return segment?.getAttribute('data-context-quote-projection-version') ===
    String(MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V2)
    ? MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V2
    : null;
}

function selectionSource(selection: Selection): {
  kind: string | null;
  mixed: boolean;
  coordinateRoot: Element | null;
  segmentId: string | null;
  projectionVersion: typeof MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V2 | null;
} {
  const anchorSource = sourceElement(selection.anchorNode)?.closest('[data-context-quote-source]');
  const focusSource = sourceElement(selection.focusNode)?.closest('[data-context-quote-source]');
  if (anchorSource !== focusSource) {
    return { kind: null, mixed: true, coordinateRoot: null, segmentId: null, projectionVersion: null };
  }

  const range = selection.getRangeAt(0);
  const commonElement = sourceElement(range.commonAncestorContainer);
  if (commonElement && typeof range.intersectsNode === 'function') {
    const markedSources = [
      ...(commonElement.matches('[data-context-quote-source]') ? [commonElement] : []),
      ...Array.from(commonElement.querySelectorAll('[data-context-quote-source]')),
    ];
    const crossesNestedSource = markedSources.some((candidate) => {
      if (candidate === anchorSource) return false;
      try {
        return range.intersectsNode(candidate);
      } catch {
        return false;
      }
    });
    if (crossesNestedSource) {
      return { kind: null, mixed: true, coordinateRoot: null, segmentId: null, projectionVersion: null };
    }
  }

  const kind = anchorSource?.getAttribute('data-context-quote-source') ?? null;
  if (kind === 'cli_output') {
    const anchorSegment = sourceElement(selection.anchorNode)?.closest('[data-context-quote-segment-id]');
    const focusSegment = sourceElement(selection.focusNode)?.closest('[data-context-quote-segment-id]');
    const segment = anchorSegment && anchorSegment === focusSegment ? anchorSegment : null;
    return {
      kind,
      mixed: false,
      coordinateRoot: segment,
      segmentId: segment?.getAttribute('data-context-quote-segment-id') ?? null,
      projectionVersion: cliProjectionVersion(segment),
    };
  }

  return {
    kind,
    mixed: false,
    coordinateRoot: anchorSource ?? null,
    segmentId: null,
    projectionVersion: null,
  };
}

function selectionBelongsToContainer(selection: Selection | null, container: HTMLElement): selection is Selection {
  return Boolean(
    selection &&
      !selection.isCollapsed &&
      container.contains(selection.anchorNode) &&
      container.contains(selection.focusNode),
  );
}

function projectSelectionAction(
  selection: Selection | null,
  container: HTMLElement,
  coordinateSpace: 'container' | 'viewport',
): TextSelectionAction | null {
  if (!selectionBelongsToContainer(selection, container)) return null;
  const rawText = selection.toString();
  const text = rawText.trim();
  if (!text) return null;

  const viewport =
    coordinateSpace === 'container'
      ? rectLike(container.getBoundingClientRect())
      : {
          top: 0,
          left: 0,
          right: window.innerWidth,
          bottom: window.innerHeight,
          width: window.innerWidth,
          height: window.innerHeight,
        };
  const position = positionSelectionActionForAnchors(selectionAnchorRects(selection), viewport);
  const source = selectionSource(selection);
  if (source.coordinateRoot && crossesExcludedChrome(selection.getRangeAt(0), source.coordinateRoot)) return null;
  const offsetRoot = source.kind === 'cli_output' ? source.coordinateRoot : (source.coordinateRoot ?? container);
  const offsets = offsetRoot ? selectionOffsets(selection, offsetRoot) : null;
  const trimmedOffsets = trimSelectionOffsets(offsets, rawText);
  if (!position || source.mixed) return null;
  const renderedRoot = source.coordinateRoot ?? container;
  return {
    text,
    position,
    sourceKind: source.kind,
    renderedOccurrences: countRenderedOccurrences(renderedRoot, text),
    sourceProjectionVersion: source.projectionVersion ?? undefined,
    ...(trimmedOffsets && source.segmentId ? { sourceSegmentId: source.segmentId } : {}),
    ...(trimmedOffsets ? { selectionStart: trimmedOffsets.start, selectionEnd: trimmedOffsets.end } : {}),
  };
}

export function useTextSelectionAction(
  containerRef: RefObject<HTMLElement>,
  active: boolean,
  resetKey: string | null,
  coordinateSpace: 'container' | 'viewport' = 'container',
): TextSelectionAction | null {
  const [action, setAction] = useState<TextSelectionAction | null>(null);

  useEffect(() => {
    // resetKey is an explicit invalidation token: a new message/file must reinstall
    // the selection projection even when every other dependency is unchanged.
    void resetKey;
    const container = containerRef.current;
    if (!container || !active) {
      setAction(null);
      return;
    }

    const sync = () => setAction(projectSelectionAction(window.getSelection(), container, coordinateSpace));

    document.addEventListener('selectionchange', sync);
    document.addEventListener('scroll', sync, true);
    window.addEventListener('resize', sync);
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
    resizeObserver?.observe(container);
    sync();
    return () => {
      document.removeEventListener('selectionchange', sync);
      document.removeEventListener('scroll', sync, true);
      window.removeEventListener('resize', sync);
      resizeObserver?.disconnect();
    };
  }, [active, containerRef, coordinateSpace, resetKey]);

  return action;
}
