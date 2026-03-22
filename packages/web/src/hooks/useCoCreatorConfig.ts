'use client';

import { useEffect, useState } from 'react';
import type { CoCreatorConfig } from '@/components/config-viewer-types';
import { refreshCoCreatorMentionData, resetMentionDataForTest } from '@/lib/mention-highlight';
import { apiFetch } from '@/utils/api-client';

const DEFAULT_CO_CREATOR: CoCreatorConfig = {
  name: 'ME',
  aliases: [],
  mentionPatterns: ['@co-creator'],
  color: {
    primary: '#815b5b',
    secondary: '#FFDDD2',
  },
};

let cachedCoCreator: CoCreatorConfig | null = null;
let fetchCoCreatorPromise: Promise<CoCreatorConfig> | null = null;
const listeners = new Set<(cc: CoCreatorConfig) => void>();

function publishCoCreator(next: CoCreatorConfig): void {
  cachedCoCreator = next;
  refreshCoCreatorMentionData(next.mentionPatterns);
  for (const listener of listeners) listener(next);
}

async function fetchCoCreator(): Promise<CoCreatorConfig> {
  const res = await apiFetch('/api/config');
  if (!res.ok) {
    throw new Error(`failed to load co-creator config: ${res.status}`);
  }
  const body = (await res.json().catch(() => ({}))) as { config?: { coCreator?: CoCreatorConfig } };
  return body.config?.coCreator ?? DEFAULT_CO_CREATOR;
}

export function useCoCreatorConfig(): CoCreatorConfig {
  const [coCreator, setCoCreator] = useState<CoCreatorConfig>(() => cachedCoCreator ?? DEFAULT_CO_CREATOR);

  useEffect(() => {
    listeners.add(setCoCreator);
    if (cachedCoCreator) {
      setCoCreator(cachedCoCreator);
      return () => {
        listeners.delete(setCoCreator);
      };
    }
    if (!fetchCoCreatorPromise) {
      fetchCoCreatorPromise = fetchCoCreator()
        .then((next) => {
          publishCoCreator(next);
          return next;
        })
        .catch((error) => {
          fetchCoCreatorPromise = null;
          throw error;
        });
    }
    let cancelled = false;
    fetchCoCreatorPromise
      .then((next) => {
        if (!cancelled) setCoCreator(next);
      })
      .catch(() => {
        if (!cancelled) {
          refreshCoCreatorMentionData(DEFAULT_CO_CREATOR.mentionPatterns);
          setCoCreator(DEFAULT_CO_CREATOR);
        }
      });
    return () => {
      cancelled = true;
      listeners.delete(setCoCreator);
    };
  }, []);

  return coCreator;
}

export function resetCoCreatorConfigCacheForTest(): void {
  cachedCoCreator = null;
  fetchCoCreatorPromise = null;
  listeners.clear();
  resetMentionDataForTest();
}

export function primeCoCreatorConfigCache(cc: CoCreatorConfig): void {
  publishCoCreator(cc);
  fetchCoCreatorPromise = Promise.resolve(cc);
}
