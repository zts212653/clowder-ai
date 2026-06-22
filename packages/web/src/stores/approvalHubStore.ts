'use client';

/**
 * F246: Approval Hub Zustand store.
 *
 * Manages pending approval items across features (F128 thread proposals,
 * F225 session handoff proposals, F193 dispatch proposals). Fetches from
 * the aggregation endpoint and re-fetches on proposal_updated /
 * proposal_created socket events (dispatched as CustomEvents by useSocket).
 *
 * Phase B: approve/reject actions for inlineApprovable items (F193).
 */

import type { ApprovalItem } from '@cat-cafe/shared';
import { create } from 'zustand';
import { apiFetch } from '@/utils/api-client';

/** Result of a batch operation for a single item. */
interface BatchItemResult {
  proposalId: string;
  success: boolean;
  error?: string;
}

interface ApprovalHubState {
  items: ApprovalItem[];
  count: number;
  isLoading: boolean;
  isOpen: boolean;
  error: string | null;
  /** Map of proposalId → 'approving' | 'rejecting' for optimistic UI feedback */
  deciding: Record<string, 'approving' | 'rejecting'>;
  /** AC-D5: Set of selected proposalIds for batch operations */
  selectedIds: Set<string>;
  /** AC-D5: Results of the last batch operation (cleared on next batch) */
  batchResults: BatchItemResult[];
  fetchPending: () => Promise<void>;
  open: () => void;
  close: () => void;
  toggle: () => void;
  /** F246 Phase B: approve an inlineApprovable dispatch proposal */
  approveProposal: (proposalId: string) => Promise<void>;
  /** F246 Phase B: reject an inlineApprovable dispatch proposal */
  rejectProposal: (proposalId: string) => Promise<void>;
  /** AC-D5: toggle selection of a proposal (only inlineApprovable allowed) */
  toggleSelection: (proposalId: string) => void;
  /** AC-D5: select all inlineApprovable items (optionally scoped to visible IDs from filters) */
  selectAllInline: (visibleIds?: string[]) => void;
  /** AC-D5: clear selection */
  clearSelection: () => void;
  /** AC-D5: batch approve all selected items */
  batchApprove: () => Promise<BatchItemResult[]>;
  /** AC-D5: batch reject all selected items */
  batchReject: () => Promise<BatchItemResult[]>;
}

export const useApprovalHubStore = create<ApprovalHubState>((set, get) => ({
  items: [],
  count: 0,
  isLoading: false,
  isOpen: false,
  error: null,
  deciding: {},
  selectedIds: new Set<string>(),
  batchResults: [],

  fetchPending: async () => {
    set({ isLoading: true, error: null });
    try {
      const res = await apiFetch('/api/approval-hub/pending');
      if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
      const data = (await res.json()) as { items: ApprovalItem[]; count: number };
      set({ items: data.items, count: data.count, isLoading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Unknown error', isLoading: false });
    }
  },

  open: () => {
    set({ isOpen: true });
    // Refresh on open to ensure fresh data
    get().fetchPending();
  },
  close: () => set({ isOpen: false }),
  toggle: () => {
    const wasOpen = get().isOpen;
    set({ isOpen: !wasOpen });
    if (!wasOpen) get().fetchPending();
  },

  approveProposal: async (proposalId: string) => {
    set((s) => ({ deciding: { ...s.deciding, [proposalId]: 'approving' as const } }));
    try {
      const res = await apiFetch(`/api/dispatch-proposals/${proposalId}/approve`, { method: 'POST' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Approve failed: ${res.status}`);
      }
      // Optimistic remove from items list
      set((s) => ({
        items: s.items.filter((i) => i.proposalId !== proposalId),
        count: Math.max(0, s.count - 1),
        deciding: { ...s.deciding, [proposalId]: undefined as never },
      }));
    } catch (err) {
      set((s) => ({
        error: err instanceof Error ? err.message : 'Approve failed',
        deciding: { ...s.deciding, [proposalId]: undefined as never },
      }));
    }
  },

  rejectProposal: async (proposalId: string) => {
    set((s) => ({ deciding: { ...s.deciding, [proposalId]: 'rejecting' as const } }));
    try {
      const res = await apiFetch(`/api/dispatch-proposals/${proposalId}/reject`, { method: 'POST' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Reject failed: ${res.status}`);
      }
      // Optimistic remove from items list
      set((s) => ({
        items: s.items.filter((i) => i.proposalId !== proposalId),
        count: Math.max(0, s.count - 1),
        deciding: { ...s.deciding, [proposalId]: undefined as never },
      }));
    } catch (err) {
      set((s) => ({
        error: err instanceof Error ? err.message : 'Reject failed',
        deciding: { ...s.deciding, [proposalId]: undefined as never },
      }));
    }
  },

  // --- AC-D5: Batch operations ---

  toggleSelection: (proposalId: string) => {
    set((s) => {
      // Only allow selecting inlineApprovable items
      const item = s.items.find((i) => i.proposalId === proposalId);
      if (!item?.inlineApprovable) return s;
      const next = new Set(s.selectedIds);
      if (next.has(proposalId)) {
        next.delete(proposalId);
      } else {
        next.add(proposalId);
      }
      return { selectedIds: next };
    });
  },

  selectAllInline: (visibleIds?: string[]) => {
    set((s) => {
      const visibleSet = visibleIds ? new Set(visibleIds) : null;
      return {
        selectedIds: new Set(
          s.items
            .filter((i) => i.inlineApprovable && (!visibleSet || visibleSet.has(i.proposalId)))
            .map((i) => i.proposalId),
        ),
      };
    });
  },

  clearSelection: () => set({ selectedIds: new Set<string>() }),

  batchApprove: async () => {
    const { selectedIds, items } = get();
    const targets = items.filter((i) => selectedIds.has(i.proposalId) && i.inlineApprovable);
    if (targets.length === 0) return [];

    const results: BatchItemResult[] = [];
    // Set all as deciding
    const decidingUpdate: Record<string, 'approving'> = {};
    for (const t of targets) decidingUpdate[t.proposalId] = 'approving';
    // Clear selectedIds immediately (double-click guard): prevents re-entry
    // if operator clicks batch button again before the sequential loop completes.
    // The targets snapshot was already captured above via get().
    set((s) => ({ deciding: { ...s.deciding, ...decidingUpdate }, batchResults: [], selectedIds: new Set<string>() }));

    // Execute sequentially to avoid overwhelming the server
    for (const t of targets) {
      try {
        const res = await apiFetch(`/api/dispatch-proposals/${t.proposalId}/approve`, { method: 'POST' });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          results.push({ proposalId: t.proposalId, success: false, error: data.error ?? `${res.status}` });
        } else {
          results.push({ proposalId: t.proposalId, success: true });
        }
      } catch (err) {
        results.push({
          proposalId: t.proposalId,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    // Update state: remove successful items, clear deciding for all, store results
    const succeededIds = new Set(results.filter((r) => r.success).map((r) => r.proposalId));
    set((s) => {
      const nextDeciding = { ...s.deciding };
      for (const t of targets) delete nextDeciding[t.proposalId];
      return {
        items: s.items.filter((i) => !succeededIds.has(i.proposalId)),
        count: Math.max(0, s.count - succeededIds.size),
        deciding: nextDeciding,
        selectedIds: new Set<string>(),
        batchResults: results,
      };
    });
    return results;
  },

  batchReject: async () => {
    const { selectedIds, items } = get();
    const targets = items.filter((i) => selectedIds.has(i.proposalId) && i.inlineApprovable);
    if (targets.length === 0) return [];

    const results: BatchItemResult[] = [];
    const decidingUpdate: Record<string, 'rejecting'> = {};
    for (const t of targets) decidingUpdate[t.proposalId] = 'rejecting';
    // Clear selectedIds immediately (double-click guard) — mirrors batchApprove
    set((s) => ({ deciding: { ...s.deciding, ...decidingUpdate }, batchResults: [], selectedIds: new Set<string>() }));

    for (const t of targets) {
      try {
        const res = await apiFetch(`/api/dispatch-proposals/${t.proposalId}/reject`, { method: 'POST' });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          results.push({ proposalId: t.proposalId, success: false, error: data.error ?? `${res.status}` });
        } else {
          results.push({ proposalId: t.proposalId, success: true });
        }
      } catch (err) {
        results.push({
          proposalId: t.proposalId,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    const succeededIds = new Set(results.filter((r) => r.success).map((r) => r.proposalId));
    set((s) => {
      const nextDeciding = { ...s.deciding };
      for (const t of targets) delete nextDeciding[t.proposalId];
      return {
        items: s.items.filter((i) => !succeededIds.has(i.proposalId)),
        count: Math.max(0, s.count - succeededIds.size),
        deciding: nextDeciding,
        selectedIds: new Set<string>(),
        batchResults: results,
      };
    });
    return results;
  },
}));
