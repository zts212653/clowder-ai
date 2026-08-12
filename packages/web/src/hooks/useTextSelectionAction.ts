'use client';

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

function selectionSource(selection: Selection): { kind: string | null; mixed: boolean } {
  const anchorSource = sourceElement(selection.anchorNode)?.closest('[data-context-quote-source]');
  const focusSource = sourceElement(selection.focusNode)?.closest('[data-context-quote-source]');
  if (anchorSource !== focusSource) return { kind: null, mixed: true };

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
    if (crossesNestedSource) return { kind: null, mixed: true };
  }

  return { kind: anchorSource?.getAttribute('data-context-quote-source') ?? null, mixed: false };
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

    const sync = () => {
      const selection = window.getSelection();
      if (
        !selection ||
        selection.isCollapsed ||
        !selection.toString().trim() ||
        !container.contains(selection.anchorNode) ||
        !container.contains(selection.focusNode)
      ) {
        setAction(null);
        return;
      }

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
      setAction(
        position && !source.mixed ? { text: selection.toString().trim(), position, sourceKind: source.kind } : null,
      );
    };

    document.addEventListener('selectionchange', sync);
    document.addEventListener('scroll', sync, true);
    window.addEventListener('resize', sync);
    sync();
    return () => {
      document.removeEventListener('selectionchange', sync);
      document.removeEventListener('scroll', sync, true);
      window.removeEventListener('resize', sync);
    };
  }, [active, containerRef, coordinateSpace, resetKey]);

  return action;
}
