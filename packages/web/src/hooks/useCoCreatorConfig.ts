'use client';

import { useEffect, useSyncExternalStore } from 'react';
import type { CoCreatorConfig } from '@/components/config-viewer-types';
import { refreshCoCreatorMentionData, resetMentionDataForTest } from '@/lib/mention-highlight';
import { apiFetch } from '@/utils/api-client';

/* The placeholder the hook starts with, and falls back to when the config cannot be loaded. It carries no colour on
 * purpose: a colour here would be painted for a moment as if it were the user's and then corrected (F322 human message).
 * Every consumer that needs a colour already has its own fallback for a config without one. */
const DEFAULT_CO_CREATOR: CoCreatorConfig = {
  name: 'ME',
  aliases: [],
  mentionPatterns: ['@co-creator'],
};

let cachedCoCreator: CoCreatorConfig | null = null;
let fetchCoCreatorPromise: Promise<CoCreatorConfig> | null = null;
const listeners = new Set<(cc: CoCreatorConfig) => void>();

function publishCoCreator(next: CoCreatorConfig): void {
  cachedCoCreator = next;
  refreshCoCreatorMentionData(next.mentionPatterns);
  for (const listener of listeners) listener(next);
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
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
  const coCreator = useSyncExternalStore(
    subscribe,
    () => cachedCoCreator ?? DEFAULT_CO_CREATOR,
    () => DEFAULT_CO_CREATOR,
  );

  useEffect(() => {
    if (cachedCoCreator) return;
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
    fetchCoCreatorPromise.catch(() => {
      if (!cancelled) {
        refreshCoCreatorMentionData(DEFAULT_CO_CREATOR.mentionPatterns);
      }
    });
    return () => {
      cancelled = true;
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
