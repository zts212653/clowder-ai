'use client';

/**
 * F208 Phase D: Hook for operator dossier observations (AC-D1).
 *
 * Fetches observations from GET /api/dossier/observations (split endpoint,
 * separate from /api/dossier per opus-47 design review: cache lifecycle independence).
 *
 * Provides submitObservation for POST /api/dossier/observations.
 * OQ-10: staging only — observations don't auto-promote to summary layer.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DossierObservationProvenance {
  type: 'cvo';
  author: string;
  date: string;
}

export interface DossierObservation {
  id: string;
  catId: string;
  content: string;
  provenance: DossierObservationProvenance;
  createdAt: number;
}

/** Grouped response (no catId filter). */
export interface DossierObservationsGroupedResponse {
  observations: Record<string, DossierObservation[]>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDossierObservations(): {
  observations: Record<string, DossierObservation[]>;
  loading: boolean;
  error: string | null;
  submitObservation: (catId: string, content: string) => Promise<DossierObservation | null>;
  refetch: () => Promise<void>;
} {
  const [observations, setObservations] = useState<Record<string, DossierObservation[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchObservations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/dossier/observations');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as DossierObservationsGroupedResponse;
      setObservations(json.observations ?? {});
    } catch (err) {
      setError(err instanceof Error ? err.message : '观察数据加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchObservations();
  }, [fetchObservations]);

  const submitObservation = useCallback(async (catId: string, content: string): Promise<DossierObservation | null> => {
    try {
      const res = await apiFetch('/api/dossier/observations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ catId, content }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { observation: DossierObservation };
      // Optimistic update: prepend to the relevant cat's list
      setObservations((prev) => ({
        ...prev,
        [catId]: [json.observation, ...(prev[catId] ?? [])],
      }));
      return json.observation;
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交观察失败');
      return null;
    }
  }, []);

  return { observations, loading, error, submitObservation, refetch: fetchObservations };
}
