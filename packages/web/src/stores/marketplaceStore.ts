'use client';

import type {
  InstallPlan,
  MarketplaceArtifactKind,
  MarketplaceEcosystem,
  MarketplaceSearchResult,
  TrustLevel,
} from '@cat-cafe/shared';
import { create } from 'zustand';
import { apiFetch } from '@/utils/api-client';

interface MarketplaceState {
  results: MarketplaceSearchResult[];
  selectedResult: MarketplaceSearchResult | null;
  installPlan: InstallPlan | null;
  loading: boolean;
  error: string | null;
  query: string;
  ecosystemFilter: MarketplaceEcosystem[];
  trustFilter: TrustLevel[];
  artifactKindsFilter: MarketplaceArtifactKind[];
  search: (q: string) => Promise<void>;
  browse: () => Promise<void>;
  setEcosystemFilter: (ecosystems: MarketplaceEcosystem[]) => void;
  setTrustFilter: (levels: TrustLevel[]) => void;
  setArtifactKindsFilter: (kinds: MarketplaceArtifactKind[]) => void;
  selectResult: (result: MarketplaceSearchResult) => void;
  getInstallPlan: (ecosystem: MarketplaceEcosystem, artifactId: string) => Promise<void>;
  clearSelection: () => void;
}

export const useMarketplaceStore = create<MarketplaceState>((set, get) => ({
  results: [],
  selectedResult: null,
  installPlan: null,
  loading: false,
  error: null,
  query: '',
  ecosystemFilter: [],
  trustFilter: [],
  artifactKindsFilter: [],

  search: async (q: string) => {
    set({ loading: true, error: null, query: q });
    try {
      const params = new URLSearchParams({ q });
      const { ecosystemFilter, trustFilter, artifactKindsFilter } = get();
      if (ecosystemFilter.length > 0) {
        params.set('ecosystems', ecosystemFilter.join(','));
      }
      if (trustFilter.length > 0) {
        params.set('trustLevels', trustFilter.join(','));
      }
      if (artifactKindsFilter.length > 0) {
        params.set('artifactKinds', artifactKindsFilter.join(','));
      }
      const res = await apiFetch(`/api/marketplace/search?${params}`);
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      const data = (await res.json()) as { results: MarketplaceSearchResult[] };
      set({ results: data.results ?? [], loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Search failed', loading: false });
    }
  },

  browse: async () => {
    set({ loading: true, error: null, query: '' });
    try {
      const params = new URLSearchParams();
      const { ecosystemFilter, trustFilter, artifactKindsFilter } = get();
      if (ecosystemFilter.length > 0) params.set('ecosystems', ecosystemFilter.join(','));
      if (trustFilter.length > 0) params.set('trustLevels', trustFilter.join(','));
      if (artifactKindsFilter.length > 0) params.set('artifactKinds', artifactKindsFilter.join(','));
      const res = await apiFetch(`/api/marketplace/search?${params}`);
      if (!res.ok) throw new Error(`Browse failed (${res.status})`);
      const data = (await res.json()) as { results: MarketplaceSearchResult[] };
      set({ results: data.results ?? [], loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Browse failed', loading: false });
    }
  },

  setEcosystemFilter: (ecosystems) => {
    const prev = get().ecosystemFilter;
    if (ecosystems.length === prev.length && ecosystems.every((e, i) => e === prev[i])) return;
    set({ ecosystemFilter: ecosystems });
    const { query, search, browse } = get();
    if (query) search(query);
    else browse();
  },
  setTrustFilter: (levels) => {
    const prev = get().trustFilter;
    if (levels.length === prev.length && levels.every((l, i) => l === prev[i])) return;
    set({ trustFilter: levels });
    const { query, search, browse } = get();
    if (query) search(query);
    else browse();
  },
  setArtifactKindsFilter: (kinds) => {
    const prev = get().artifactKindsFilter;
    if (kinds.length === prev.length && kinds.every((k, i) => k === prev[i])) return;
    set({ artifactKindsFilter: kinds });
    const { query, search, browse } = get();
    if (query) search(query);
    else browse();
  },
  selectResult: (result) => set({ selectedResult: result }),

  getInstallPlan: async (ecosystem, artifactId) => {
    set({ loading: true, error: null });
    try {
      const res = await apiFetch('/api/marketplace/install/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ecosystem, artifactId }),
      });
      const data = (await res.json()) as { plan: InstallPlan };
      set({ installPlan: data.plan, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to get install plan', loading: false });
    }
  },

  clearSelection: () => set({ selectedResult: null, installPlan: null }),
}));
