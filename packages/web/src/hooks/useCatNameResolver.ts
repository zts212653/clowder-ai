'use client';

import { useCallback } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { resolveCatDisplayName, resolveCatTechnicalLabel } from '@/lib/cat-display-name';

/** Reactive catId → human-facing name projection backed by the runtime member registry. */
export function useCatNameResolver(): (catId: string) => string {
  const { getCatById } = useCatData({ fetch: false });
  return useCallback((catId: string) => resolveCatDisplayName(catId, getCatById), [getCatById]);
}

/** Diagnostic variant that appends the stable id when a friendly name was resolved. */
export function useCatTechnicalLabelResolver(): (catId: string) => string {
  const { getCatById } = useCatData({ fetch: false });
  return useCallback((catId: string) => resolveCatTechnicalLabel(catId, getCatById), [getCatById]);
}
