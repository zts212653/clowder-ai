'use client';

import type { CollectivePairingIntentMessage } from '@cat-cafe/shared';
import { useCallback, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export function useCollectiveEntryPairing(onPaired: (connectionId: string) => Promise<void>) {
  const [pending, setPending] = useState<CollectivePairingIntentMessage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const receive = useCallback((message: CollectivePairingIntentMessage) => {
    setPending(message);
    setError(undefined);
  }, []);
  const clear = useCallback(() => {
    setPending(undefined);
    setError(undefined);
  }, []);
  const clearError = useCallback(() => setError(undefined), []);
  const confirm = useCallback(
    async (selection: { rosterFingerprint: string; excludedCatIds: string[] }) => {
      if (!pending || busy) return;
      setBusy(true);
      setError(undefined);
      try {
        const response = await apiFetch('/api/plugins/collective-connector/pair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            serviceUrl: pending.serviceUrl,
            endpointLabel: `Clowder AI on ${window.location.host}`,
            intent: pending.intent,
            ...selection,
          }),
        });
        const body = (await response.json().catch(() => ({}))) as {
          code?: string;
          error?: string;
          connectionId?: string;
        };
        if (!response.ok) throw new Error(body.error ?? `Pairing failed (${response.status})`);
        if (!body.connectionId) throw new Error('连接已建立，但缺少连接标识，请重新读取状态。');
        await onPaired(body.connectionId);
        setPending(undefined);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '连接未完成，请重试。');
      } finally {
        setBusy(false);
      }
    },
    [busy, onPaired, pending],
  );
  return { pending, busy, error, receive, clear, clearError, confirm };
}
