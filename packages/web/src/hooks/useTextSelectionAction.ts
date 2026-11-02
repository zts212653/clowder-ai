'use client';

import {
  MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V2,
  MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V3,
} from '@cat-cafe/shared';
import { type SelectionProjectionAdapter, useTextSelectionAction as useSharedTextSelectionAction } from '@cat-cafe/ui';
import type { RefObject } from 'react';
import { isUnmappedNativeSelection, projectedSelectionOffsets } from './text-selection-source-offsets';

export type { TextSelectionAction } from '@cat-cafe/ui';

const nativeProjection: SelectionProjectionAdapter = {
  cliVersion(segment) {
    const value = segment?.getAttribute('data-context-quote-projection-version');
    if (value === String(MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V2))
      return MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V2;
    if (value === String(MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V3))
      return MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V3;
    return null;
  },
  offsets: projectedSelectionOffsets,
  isUnmapped: isUnmappedNativeSelection,
};

/** Home retains attested native-output mapping; both hosts share the DOM selection engine. */
export function useTextSelectionAction(
  containerRef: RefObject<HTMLElement>,
  active: boolean,
  resetKey: string | null,
  coordinateSpace: 'container' | 'viewport' = 'container',
) {
  return useSharedTextSelectionAction(containerRef, active, resetKey, coordinateSpace, nativeProjection);
}
