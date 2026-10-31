'use client';

import { coCreatorDisplay } from '@cat-cafe/shared';
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
let generation = 0;
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
      const ticket = ++generation;
      fetchCoCreatorPromise = fetchCoCreator()
        .then((next) => {
          if (ticket === generation) publishCoCreator(next);
          return next;
        })
        .catch((error) => {
          if (ticket === generation) fetchCoCreatorPromise = null;
          throw error;
        });
    }
    const ticket = generation;
    let cancelled = false;
    fetchCoCreatorPromise.catch(() => {
      if (!cancelled && ticket === generation) {
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
  generation += 1;
  cachedCoCreator = null;
  fetchCoCreatorPromise = null;
  listeners.clear();
  resetMentionDataForTest();
}

export function primeCoCreatorConfigCache(cc: CoCreatorConfig): void {
  generation += 1;
  publishCoCreator(cc);
  fetchCoCreatorPromise = Promise.resolve(cc);
}

export function useCoCreatorDisplay() {
  return coCreatorDisplay(useCoCreatorConfig());
}
