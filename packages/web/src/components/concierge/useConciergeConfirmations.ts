/**
 * useConciergeConfirmations (F229 Phase B)
 *
 * Mount-time hook: fetches all confirmation states for the current user,
 * indexed by messageId for O(1) lookup when rendering CardBlocks.
 *
 * INV C3: confirmed/cancelled state survives page refresh.
 */

import type { ConfirmationStatus } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export interface ConfirmationEntry {
  id: string;
  messageId: string;
  status: ConfirmationStatus;
  action: { kind: string; [key: string]: unknown };
}

/** Map from messageId → ConfirmationEntry[] (a message can have multiple confirmable actions) */
export type ConfirmationIndex = Map<string, ConfirmationEntry[]>;

interface UseConciergeConfirmationsResult {
  /** Indexed confirmations (empty Map while loading) */
  confirmations: ConfirmationIndex;
  /** True during initial fetch */
  loading: boolean;
  /** Fetch error, if any */
  error: string | null;
}

/**
 * Fetch all user confirmations on mount. Returns an index by messageId.
 * Only fetches once (mount-time); does not poll.
 */
export function useConciergeConfirmations(enabled: boolean): UseConciergeConfirmationsResult {
  const [confirmations, setConfirmations] = useState<ConfirmationIndex>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    setLoading(true);

    apiFetch('/api/concierge/confirmations')
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(`HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as { confirmations: ConfirmationEntry[] };
        const index: ConfirmationIndex = new Map();
        for (const entry of data.confirmations) {
          const existing = index.get(entry.messageId) ?? [];
          existing.push(entry);
          index.set(entry.messageId, existing);
        }
        setConfirmations(index);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load confirmations');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { confirmations, loading, error };
}
