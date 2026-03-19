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
const listeners = new Set<(owner: OwnerConfig) => void>();

function publishOwner(nextOwner: OwnerConfig): void {
  cachedOwner = nextOwner;
  for (const listener of listeners) listener(nextOwner);
}

async function fetchOwner(): Promise<OwnerConfig> {
  const res = await apiFetch('/api/config');
  if (!res.ok) return DEFAULT_OWNER;
  const body = (await res.json().catch(() => ({}))) as { config?: { owner?: OwnerConfig } };
  return body.config?.owner ?? DEFAULT_OWNER;
}

export function useOwnerConfig(): OwnerConfig {
  const [owner, setOwner] = useState<OwnerConfig>(() => cachedOwner ?? DEFAULT_OWNER);

  useEffect(() => {
    listeners.add(setOwner);
    if (cachedOwner) {
      setOwner(cachedOwner);
      return () => {
        listeners.delete(setOwner);
      };
    }
    if (!fetchOwnerPromise) {
      fetchOwnerPromise = fetchOwner().then((nextOwner) => {
        publishOwner(nextOwner);
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
      listeners.delete(setOwner);
    };
  }, []);

  return owner;
}

export function resetOwnerConfigCacheForTest(): void {
  cachedOwner = null;
  fetchOwnerPromise = null;
  listeners.clear();
}

export function primeOwnerConfigCache(owner: OwnerConfig): void {
  publishOwner(owner);
  fetchOwnerPromise = Promise.resolve(owner);
}
