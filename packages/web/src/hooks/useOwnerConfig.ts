'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { OwnerConfig } from '@/components/config-viewer-types';

const DEFAULT_OWNER: OwnerConfig = {
  name: 'ME',
  aliases: [],
  mentionPatterns: ['@owner'],
  color: {
    primary: '#E29578',
    secondary: '#FFDDD2',
  },
};

let cachedOwner: OwnerConfig | null = null;
let fetchOwnerPromise: Promise<OwnerConfig> | null = null;

async function fetchOwner(): Promise<OwnerConfig> {
  const res = await apiFetch('/api/config');
  if (!res.ok) return DEFAULT_OWNER;
  const body = (await res.json().catch(() => ({}))) as { config?: { owner?: OwnerConfig } };
  return body.config?.owner ?? DEFAULT_OWNER;
}

export function useOwnerConfig(): OwnerConfig {
  const [owner, setOwner] = useState<OwnerConfig>(() => cachedOwner ?? DEFAULT_OWNER);

  useEffect(() => {
    if (cachedOwner) {
      setOwner(cachedOwner);
      return;
    }
    if (!fetchOwnerPromise) {
      fetchOwnerPromise = fetchOwner().then((nextOwner) => {
        cachedOwner = nextOwner;
        return nextOwner;
      });
    }
    let cancelled = false;
    fetchOwnerPromise
      .then((nextOwner) => {
        if (!cancelled) setOwner(nextOwner);
      })
      .catch(() => {
        if (!cancelled) setOwner(DEFAULT_OWNER);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return owner;
}

export function resetOwnerConfigCacheForTest(): void {
  cachedOwner = null;
  fetchOwnerPromise = null;
}

export function primeOwnerConfigCache(owner: OwnerConfig): void {
  cachedOwner = owner;
  fetchOwnerPromise = Promise.resolve(owner);
}
