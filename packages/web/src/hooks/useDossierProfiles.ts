'use client';

/**
 * F208 Phase C: Hook for fetching model-grouped dossier profiles.
 *
 * Calls GET /api/dossier which returns capability profiles grouped by model (KD-15).
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

// ---------------------------------------------------------------------------
// Types (mirrors API response shape from packages/api/src/routes/dossier.ts)
// ---------------------------------------------------------------------------

export interface DossierProvenance {
  version: string;
  date: string;
  primarySources?: string[];
}

export interface DossierRoutingSignals {
  peakCapabilities?: string[];
  antiSignals?: string[];
}

export interface DossierProfileData {
  entityId: string;
  oneLiner?: string;
  l0RosterSummary?: string;
  routingSignals?: DossierRoutingSignals;
  provenance?: DossierProvenance;
}

export interface DossierCatEntry {
  catId: string;
  displayName: string;
  nickname?: string;
  family?: string;
  runtime?: string;
  dossier: DossierProfileData | null;
}

export interface DossierModelGroup {
  model: string;
  cats: DossierCatEntry[];
}

export interface DossierMeta {
  totalCats: number;
  totalModels: number;
  dossierCoverage: number;
}

export interface DossierResponse {
  modelGroups: DossierModelGroup[];
  meta: DossierMeta;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDossierProfiles(): {
  data: DossierResponse | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
} {
  const [data, setData] = useState<DossierResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProfiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/dossier');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as DossierResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : '画像数据加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  return { data, loading, error, refetch: fetchProfiles };
}

// ---------------------------------------------------------------------------
// Pure derivation — extracted for testability (F208 OQ-9 / KD-14)
// ---------------------------------------------------------------------------

/**
 * Check whether a cat's dossier covers the teamStrengths field (l0RosterSummary present).
 * This is the per-field gate for the OQ-9 badge — dossier existence alone is not enough.
 */
export function catDossierCoversStrengths(catId: string, data: DossierResponse | null): boolean {
  if (!data?.modelGroups) return false;
  return data.modelGroups.some((g) => g.cats.some((c) => c.catId === catId && c.dossier?.l0RosterSummary != null));
}
