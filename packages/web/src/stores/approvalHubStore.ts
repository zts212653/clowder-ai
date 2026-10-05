'use client';

/**
 * F246: Approval Hub Zustand store.
 *
 * Manages pending approval items across registered feature adapters. Fetches
 * from the aggregation endpoint and re-fetches on proposal_updated /
 * proposal_created socket events (dispatched as CustomEvents by useSocket).
 *
 * Phase B: approve/reject actions for inlineApprovable items (F193).
 */

import type {
  ApprovalHubItem,
  EntityConflictContext,
  EntityConflictResolutionRequest,
  HumanDispositionFeedbackInput,
  SettledApprovalHubItem,
} from '@cat-cafe/shared';
import { create } from 'zustand';
import { isApprovalItemBatchDecidable } from '@/lib/approval-features';
import { apiFetch } from '@/utils/api-client';
import { createApprovalDecisionActions } from './approval-decision-actions';
import { consumeDecisionAttempt, type DecisionAttempts } from './approval-decision-attempts';
import {
  applyConflictFeedback,
  type DecidingMap,
  type DecisionErrorBody,
  decisionErrorMessage,
  resolveEndpoint,
} from './approval-decision-http';

/** Result of a batch operation for a single item. */
interface BatchItemResult {
  proposalId: string;
  success: boolean;
  error?: string;
}

interface ApprovalHubState {
  items: ApprovalHubItem[];
  count: number;
  isLoading: boolean;
  isOpen: boolean;
  error: string | null;
  /** Map of proposalId → 'approving' | 'rejecting' for optimistic UI feedback */
  deciding: DecidingMap;
  /**
   * F322 S3-2b-2: the latest decision attempt per proposal, as transient raw evidence (see approval-decision-attempts.ts).
   * Not part of `items`/`count`, not a lifecycle: absence never means success.
   */
  decisionAttempts: DecisionAttempts;
  /** Drop an attempt once a host has read it; a no-op unless it is still the attempt the caller saw. */
  consumeDecisionAttempt: (proposalId: string, attemptId: number) => void;
  /** AC-D5: Set of selected proposalIds for batch operations */
  selectedIds: Set<string>;
  /** AC-D5: Results of the last batch operation (cleared on next batch) */
  batchResults: BatchItemResult[];
  /** F246 Phase F: canonical settled lifecycle history items. */
  settledItems: SettledApprovalHubItem[];
  settledIsLoading: boolean;
  settledError: string | null;
  fetchPending: () => Promise<void>;
  /** F246 Phase F: fetch normalized settled lifecycle history. */
  fetchSettled: (limit?: number) => Promise<void>;
  open: () => void;
  close: () => void;
  toggle: () => void;
  /** F246 Phase B: approve an inlineApprovable dispatch proposal */
  approveProposal: (proposalId: string) => Promise<void>;
  /** F246 Phase B: reject an inlineApprovable dispatch proposal */
  rejectProposal: (proposalId: string, feedback?: HumanDispositionFeedbackInput) => Promise<boolean>;
  /** F276: approve an exact subset of the proposal's remaining drafts. */
  approvePersonMemory: (proposalId: string, selectedDraftIds: string[]) => Promise<void>;
  /** F276: keep a proposal owner-visible without authorizing recall or materialization. */
  notNowPersonMemory: (proposalId: string) => Promise<void>;
  /** F276: cancel an unmaterialized proposal without creating rejection suppression. */
  withdrawPersonMemory: (proposalId: string) => Promise<void>;
  /** F260: submit an explicit entity conflict mutation. */
  resolveEntityConflict: (proposalId: string, resolution: EntityConflictResolutionRequest) => Promise<void>;
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
  decisionAttempts: {},
  selectedIds: new Set<string>(),
  batchResults: [],
  settledItems: [],
  settledIsLoading: false,
  settledError: null,

  fetchPending: async () => {
    set({ isLoading: true, error: null });
    try {
      const res = await apiFetch('/api/approval-hub/pending');
      if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
      const data = (await res.json()) as { items: ApprovalHubItem[]; count: number };
      set({ items: data.items, count: data.count, isLoading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Unknown error', isLoading: false });
    }
  },

  fetchSettled: async (limit = 200) => {
    set({ settledIsLoading: true, settledError: null });
    try {
      const res = await apiFetch(`/api/approval-hub/settled?limit=${limit}`);
      if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
      const data = (await res.json()) as { items: SettledApprovalHubItem[]; count: number };
      set({ settledItems: data.items, settledIsLoading: false });
    } catch (err) {
      set({ settledError: err instanceof Error ? err.message : 'Unknown error', settledIsLoading: false });
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

  ...createApprovalDecisionActions(set, get),

  consumeDecisionAttempt: (proposalId, attemptId) =>
    set((state) => ({ decisionAttempts: consumeDecisionAttempt(state.decisionAttempts, proposalId, attemptId) })),

  // --- AC-D5: Batch operations ---

  toggleSelection: (proposalId: string) => {
    set((s) => {
      // Recovery items are single-action resumes and must never enter approve/reject batches.
      const item = s.items.find((i) => i.proposalId === proposalId);
      if (!item || !isApprovalItemBatchDecidable(item)) return s;
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
            .filter((i) => isApprovalItemBatchDecidable(i) && (!visibleSet || visibleSet.has(i.proposalId)))
            .map((i) => i.proposalId),
        ),
      };
    });
  },

  clearSelection: () => set({ selectedIds: new Set<string>() }),

  batchApprove: async () => {
    const { selectedIds, items } = get();
    const targets = items.filter((i) => selectedIds.has(i.proposalId) && isApprovalItemBatchDecidable(i));
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
        const res = await apiFetch(resolveEndpoint(t.sourceFeatureId, t.proposalId, 'approve'), { method: 'POST' });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as DecisionErrorBody;
          if (data.conflict) {
            const message = decisionErrorMessage(data, `${res.status}`);
            set((state) => ({
              items: applyConflictFeedback(state.items, t.proposalId, data.conflict as EntityConflictContext, message),
            }));
          }
          results.push({
            proposalId: t.proposalId,
            success: false,
            error: decisionErrorMessage(data, `${res.status}`),
          });
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
    const targets = items.filter((i) => selectedIds.has(i.proposalId) && isApprovalItemBatchDecidable(i));
    if (targets.length === 0) return [];

    const results: BatchItemResult[] = [];
    const decidingUpdate: Record<string, 'rejecting'> = {};
    for (const t of targets) decidingUpdate[t.proposalId] = 'rejecting';
    // Clear selectedIds immediately (double-click guard) — mirrors batchApprove
    set((s) => ({ deciding: { ...s.deciding, ...decidingUpdate }, batchResults: [], selectedIds: new Set<string>() }));

    for (const t of targets) {
      try {
        const res = await apiFetch(resolveEndpoint(t.sourceFeatureId, t.proposalId, 'reject'), { method: 'POST' });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as DecisionErrorBody;
          results.push({
            proposalId: t.proposalId,
            success: false,
            error: decisionErrorMessage(data, `${res.status}`),
          });
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
