'use client';

import { resolveSharedMarkdownSelection } from '@cat-cafe/shared';
import { type RefObject, useMemo } from 'react';
import { useTextSelectionAction } from '@/hooks/useTextSelectionAction';
import type { FloatingSelectionPosition } from './selection-action-position';
import { useSelectionAtVersion } from './useSelectionAtVersion';

export interface MarkdownSelectionAction {
  text: string;
  position: FloatingSelectionPosition;
  selectionStart?: number;
  selectionEnd?: number;
  /** The version of the file the selection was made in; absent where the version was not known. */
  version?: string | null;
}

/** `version` is the version of the file on screen: each selection takes the one current when it was made. */
export function useMarkdownSelectionAction(
  containerRef: RefObject<HTMLDivElement>,
  active: boolean,
  resetKey: string | null,
  version: string | null = null,
  ownerSourceText?: string,
): MarkdownSelectionAction | null {
  const action = useSelectionAtVersion(useTextSelectionAction(containerRef, active, resetKey, 'container'), version);
  return useMemo(() => {
    if (!action || ownerSourceText === undefined) return action;
    const span = ownerMarkdownSelection(containerRef.current, ownerSourceText, action.text);
    return { ...action, selectionStart: span?.start, selectionEnd: span?.end };
  }, [action, containerRef, ownerSourceText]);
}

/** Capture the selected rendered block before the shared comment editor takes focus. */
export function ownerMarkdownSelection(container: HTMLElement | null, source: string, text: string) {
  const selection = typeof window === 'undefined' ? null : window.getSelection();
  const node = selection?.rangeCount ? selection.getRangeAt(0).commonAncestorContainer : null;
  const element = node instanceof Element ? node : node?.parentElement;
  const block = container?.contains(element ?? null) ? element?.closest<HTMLElement>('[data-source-line]') : null;
  if (!block || !container) return resolveSharedMarkdownSelection(source, text);
  const line = Number(block.dataset.sourceLine);
  const offsets = [0, ...Array.from(source.matchAll(/\n/gu), (match) => match.index + 1)];
  const start = offsets[line - 1];
  if (!Number.isSafeInteger(line) || start === undefined) return null;
  const nextLine = Math.min(
    ...Array.from(container.querySelectorAll<HTMLElement>('[data-source-line]'), (item) =>
      Number(item.dataset.sourceLine),
    ).filter((value) => value > line),
  );
  return resolveSharedMarkdownSelection(source, text, { start, end: offsets[nextLine - 1] ?? source.length });
}
