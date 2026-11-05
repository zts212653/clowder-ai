'use client';

import { useEffect } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { CollectiveConnectorStatus } from './collective-client';
import { recoverWorldDirectoryCache } from './collective-world-directory-store';

export function useCollectiveWorldDirectoryRecovery(): void {
  useEffect(() => {
    const abort = new AbortController();
    const recover = async () => {
      try {
        const response = await apiFetch('/api/plugins/official.collective-connector/connections', {
          signal: abort.signal,
        });
        const status = (await response.json()) as CollectiveConnectorStatus;
        if (!response.ok || status.runtimeStatus !== 'active' || !Array.isArray(status.connections)) return;
        recoverWorldDirectoryCache(status.connections);
      } catch {
        // Unknown remains distinct from an empty verified directory; the live iframe can retry later.
      }
    };
    void recover();
    return () => abort.abort();
  }, []);
}
