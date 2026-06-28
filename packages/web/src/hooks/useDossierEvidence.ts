'use client';

/**
 * F208 Phase D: Hook for dossier evidence display (AC-D2).
 *
 * Lazy-fetches from existing GET /api/evidence/search with cat nickname/name.
 * "直接接通" — uses existing evidence search, no proxy layer.
 *
 * Empirical query strategy (opus-47 design review): start with nickname,
 * fallback to catId if nickname not available.
 */

import { useCallback, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

// ---------------------------------------------------------------------------
// Types (mirrors evidence search API response shape)
// ---------------------------------------------------------------------------

export interface EvidenceSnippet {
  title: string;
  anchor: string;
  snippet: string;
  confidence: 'high' | 'mid' | 'low';
  sourceType: string;
  sourcePath?: string;
}

interface EvidenceSearchResponse {
  results: EvidenceSnippet[];
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDossierEvidence(): {
  evidence: Record<string, EvidenceSnippet[]>;
  loading: Record<string, boolean>;
  fetchEvidence: (catId: string, searchKey: string) => Promise<void>;
} {
  const [evidence, setEvidence] = useState<Record<string, EvidenceSnippet[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  const fetchEvidence = useCallback(
    async (catId: string, searchKey: string) => {
      // Already loaded or loading — skip
      if (evidence[catId] || loading[catId]) return;

      setLoading((prev) => ({ ...prev, [catId]: true }));
      try {
        const query = encodeURIComponent(searchKey);
        const res = await apiFetch(`/api/evidence/search?q=${query}&scope=threads&mode=hybrid&limit=5`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as EvidenceSearchResponse;
        setEvidence((prev) => ({ ...prev, [catId]: json.results ?? [] }));
      } catch {
        // Silently degrade — evidence is supplementary, not blocking
        setEvidence((prev) => ({ ...prev, [catId]: [] }));
      } finally {
        setLoading((prev) => ({ ...prev, [catId]: false }));
      }
    },
    [evidence, loading],
  );

  return { evidence, loading, fetchEvidence };
}
