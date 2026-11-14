import {
  type FloatingSelectionPosition,
  positionSelectionActionForAnchors,
  type RectLike,
} from './selection-action-position';
import { projectDomSelectionOffsets, type SelectionOffsetSource } from './text-selection-offsets';
import { clippedRangeWithin, readableSelectionText } from './text-selection-readable';

export interface TextSelectionAction {
  text: string;
  position: FloatingSelectionPosition;
  sourceKind: string | null;
  sourceSegmentId?: string;
  sourceProjectionVersion?: 2 | 3;
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

function rangeSelectsTextWithin(range: Range, candidate: Element): boolean {
  return Boolean(clippedRangeWithin(range, candidate)?.toString().trim());
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
  // Keep block separators. Chromium can insert extra newlines at inline-flex chips in a
  // Selection compared with innerText; collapse whitespace in both, as quote admission does.
  // textContent remains only for non-layout DOMs such as jsdom.
  const rendered =
    root instanceof HTMLElement && typeof root.innerText === 'string' ? root.innerText : (root.textContent ?? '');
  const normalize = (value: string) => value.trim().replace(/\s+/gu, ' ');
  return normalize(rendered).split(normalize(text)).length - 1;
}

type CliProjectionVersion = NonNullable<TextSelectionAction['sourceProjectionVersion']>;

export interface SelectionProjectionAdapter {
  cliVersion(segment: Element | null): 2 | 3 | null;
  offsets(
    source: SelectionOffsetSource,
    selection: Selection,
    container: HTMLElement,
    selectedText: string,
  ): { start: number; end: number } | null;
  isUnmapped(root: Element | null, offsets: { start: number; end: number } | null): boolean;
}

function matchingSubtree(root: Element, selector: string): Element[] {
  return [...(root.matches(selector) ? [root] : []), ...Array.from(root.querySelectorAll(selector))];
}

function rangeLocalCandidates(range: Range, root: Element, selector: string): Element[] {
  const commonNode = range.commonAncestorContainer;
  const common = commonNode.nodeType === Node.ELEMENT_NODE ? (commonNode as Element) : commonNode.parentElement;
  if (!common) return [];
  if (common.contains(root)) return matchingSubtree(root, selector);
  if (!root.contains(common)) return [];

  const candidates = new Set(matchingSubtree(common, selector));
  for (let ancestor = common.parentElement; ancestor && root.contains(ancestor); ancestor = ancestor.parentElement) {
    if (ancestor.matches(selector)) candidates.add(ancestor);
    if (ancestor === root) break;
  }
  return Array.from(candidates);
}

function selectedLeaves(range: Range, root: Element, selector: string): Element[] {
  const selected = rangeLocalCandidates(range, root, selector).filter((candidate) =>
    rangeSelectsTextWithin(range, candidate),
  );
  return selected.filter((candidate) => !selected.some((other) => candidate !== other && candidate.contains(other)));
}

function sameSelectedContent(left: string, right: string): boolean {
  // Selection.toString() can synthesize layout whitespace between rendered blocks while a
  // clipped Range serializes only DOM text. Source admission cares whether any characters,
  // rather than pointer-only whitespace, came from outside the candidate.
  return left.replace(/\s/gu, '') === right.replace(/\s/gu, '');
}

interface SelectionSource {
  kind: string | null;
  mixed: boolean;
  coordinateRoot: Element | null;
  coordinateRange: Range | null;
  segmentId: string | null;
  projectionVersion: CliProjectionVersion | null;
}

const MIXED_SELECTION_SOURCE: SelectionSource = {
  kind: null,
  mixed: true,
  coordinateRoot: null,
  coordinateRange: null,
  segmentId: null,
  projectionVersion: null,
};

function cliSelectionSource(
  range: Range,
  source: Element,
  rawText: string,
  projection?: SelectionProjectionAdapter,
): SelectionSource {
  const segments = selectedLeaves(range, source, '[data-context-quote-segment-id]');
  if (segments.length === 0) {
    return {
      kind: 'cli_output',
      mixed: false,
      coordinateRoot: null,
      coordinateRange: null,
      segmentId: null,
      projectionVersion: null,
    };
  }
  const segment = segments.length === 1 ? segments[0] : null;
  const segmentRange = segment ? clippedRangeWithin(range, segment) : null;
  if (!segment || !segmentRange || !sameSelectedContent(segmentRange.toString(), rawText)) {
    return MIXED_SELECTION_SOURCE;
  }
  return {
    kind: 'cli_output',
    mixed: false,
    coordinateRoot: segment,
    coordinateRange: segmentRange,
    segmentId: segment.getAttribute('data-context-quote-segment-id'),
    projectionVersion: projection?.cliVersion(segment) ?? null,
  };
}

function selectionSource(
  selection: Selection,
  container: HTMLElement,
  projection?: SelectionProjectionAdapter,
): SelectionSource {
  const range = selection.getRangeAt(0);
  const rawText = selection.toString().trim();
  // Endpoint nodes describe pointer release geometry, not necessarily selected content. Resolve
  // ownership from the Range's non-whitespace contribution and require one deepest marked owner.
  const sources = selectedLeaves(range, container, '[data-context-quote-source]');
  if (sources.length === 0) {
    return {
      kind: null,
      mixed: false,
      coordinateRoot: null,
      coordinateRange: clippedRangeWithin(range, container),
      segmentId: null,
      projectionVersion: null,
    };
  }
  const source = sources.length === 1 ? sources[0] : null;
  const sourceRange = source ? clippedRangeWithin(range, source) : null;
  if (!source || !sourceRange || !sameSelectedContent(sourceRange.toString(), rawText)) {
    return MIXED_SELECTION_SOURCE;
  }

  const kind = source.getAttribute('data-context-quote-source');
  if (kind === 'cli_output') return cliSelectionSource(range, source, rawText, projection);

  return {
    kind,
    mixed: false,
    coordinateRoot: source,
    coordinateRange: sourceRange,
    segmentId: null,
    projectionVersion: null,
  };
}

function selectionViewport(container: HTMLElement, coordinateSpace: 'container' | 'viewport'): RectLike {
  if (coordinateSpace === 'container') return rectLike(container.getBoundingClientRect());
  return {
    top: 0,
    left: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
    width: window.innerWidth,
    height: window.innerHeight,
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

export function projectSelectionAction(
  selection: Selection | null,
  container: HTMLElement,
  coordinateSpace: 'container' | 'viewport',
  projection?: SelectionProjectionAdapter,
): TextSelectionAction | null {
  if (!selectionBelongsToContainer(selection, container)) return null;
  const rawText = selection.toString();
  if (!rawText.trim()) return null;

  const viewport = selectionViewport(container, coordinateSpace);
  const position = positionSelectionActionForAnchors(selectionAnchorRects(selection), viewport);
  const source = selectionSource(selection, container, projection);
  if (crossesExcludedChrome(selection.getRangeAt(0), container)) return null;
  if (!position || source.mixed) return null;
  const renderedRoot = source.coordinateRoot ?? container;
  const text = readableSelectionText(selection, renderedRoot);
  if (!text) return null;
  const trimmedOffsets = projection
    ? projection.offsets(source, selection, container, text)
    : projectDomSelectionOffsets(source, selection, container);
  if (projection?.isUnmapped(source.coordinateRoot, trimmedOffsets)) return null;
  return {
    text,
    position,
    sourceKind: source.kind,
    // Uniqueness still attests what the human saw, before restoring source spellings.
    renderedOccurrences: countRenderedOccurrences(renderedRoot, rawText.trim()),
    sourceProjectionVersion: source.projectionVersion ?? undefined,
    ...(trimmedOffsets && source.segmentId ? { sourceSegmentId: source.segmentId } : {}),
    ...(trimmedOffsets ? { selectionStart: trimmedOffsets.start, selectionEnd: trimmedOffsets.end } : {}),
  };
}
