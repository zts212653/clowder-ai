'use client';

/**
 * F246: Approval Hub sync hook.
 *
 * Fetches pending approvals on mount and re-fetches when proposal_updated
 * or proposal_created events fire (dispatched by useSocket as CustomEvents).
 * Mount once at a high level (e.g., ActivityBar) — no per-component subscription needed.
 */

import { useEffect } from 'react';
import { useApprovalHubStore } from '@/stores/approvalHubStore';

export function useApprovalHubSync() {
  const fetchPending = useApprovalHubStore((s) => s.fetchPending);

  // Initial fetch on mount
  useEffect(() => {
    fetchPending();
  }, [fetchPending]);

  // Listen for proposal_updated / proposal_created CustomEvents (dispatched by useSocket)
  useEffect(() => {
    const handler = () => {
      fetchPending();
    };
    window.addEventListener('cat-cafe:proposal-updated', handler);
    window.addEventListener('cat-cafe:proposal-created', handler);
    return () => {
      window.removeEventListener('cat-cafe:proposal-updated', handler);
      window.removeEventListener('cat-cafe:proposal-created', handler);
    };
  }, [fetchPending]);
}
