'use client';

import type { InstallPlan, MarketplaceEcosystem, MarketplaceSearchResult, TrustLevel } from '@cat-cafe/shared';
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
  search: (q: string) => Promise<void>;
  setEcosystemFilter: (ecosystems: MarketplaceEcosystem[]) => void;
  setTrustFilter: (levels: TrustLevel[]) => void;
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

  search: async (q: string) => {
    set({ loading: true, error: null, query: q });
    try {
      const params = new URLSearchParams({ q });
      const { ecosystemFilter, trustFilter } = get();
      if (ecosystemFilter.length > 0) {
        params.set('ecosystems', ecosystemFilter.join(','));
      }
      if (trustFilter.length > 0) {
        params.set('trustLevels', trustFilter.join(','));
      }
      const res = await apiFetch(`/api/marketplace/search?${params}`);
      const data = (await res.json()) as { results: MarketplaceSearchResult[] };
      set({ results: data.results, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Search failed', loading: false });
    }
  },

  setEcosystemFilter: (ecosystems) => {
    const prev = get().ecosystemFilter;
    if (ecosystems.length === prev.length && ecosystems.every((e, i) => e === prev[i])) return;
    set({ ecosystemFilter: ecosystems });
    const { query, search } = get();
    if (query) search(query);
  },
  setTrustFilter: (levels) => {
    const prev = get().trustFilter;
    if (levels.length === prev.length && levels.every((l, i) => l === prev[i])) return;
    set({ trustFilter: levels });
    const { query, search } = get();
    if (query) search(query);
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
