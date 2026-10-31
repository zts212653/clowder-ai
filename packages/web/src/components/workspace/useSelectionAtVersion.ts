'use client';

import { useRef } from 'react';

/**
 * A selection carries the version of the file it was made in. The words selected are words of that version: a card
 * opened on them can stay open while the file is loaded again, and what the person saves from it must still say the
 * version those words belong to, not whichever version is on screen when they press save.
 *
 * The version is taken the first time this selection is seen and never replaced; a new selection gets the version
 * current then. Nothing is claimed for a selection seen while the version is unknown (`null`).
 */
export function useSelectionAtVersion<T extends object>(
  selection: T | null,
  version: string | null,
): (T & { readonly version: string | null }) | null {
  const seen = useRef<{ selection: T | null; stamped: (T & { readonly version: string | null }) | null }>({
    selection: null,
    stamped: null,
  });
  if (seen.current.selection !== selection) {
    seen.current = { selection, stamped: selection ? { ...selection, version } : null };
  }
  return seen.current.stamped;
}
