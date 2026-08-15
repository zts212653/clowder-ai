'use client';

import type { RefObject } from 'react';
import { useTextSelectionAction } from '@/hooks/useTextSelectionAction';
import type { FloatingSelectionPosition } from './selection-action-position';

export interface MarkdownSelectionAction {
  text: string;
  position: FloatingSelectionPosition;
  selectionStart?: number;
  selectionEnd?: number;
}

export function useMarkdownSelectionAction(
  containerRef: RefObject<HTMLDivElement>,
  active: boolean,
  resetKey: string | null,
): MarkdownSelectionAction | null {
  return useTextSelectionAction(containerRef, active, resetKey, 'container');
}
