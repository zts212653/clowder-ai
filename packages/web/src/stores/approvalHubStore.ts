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
  ApprovalFeatureId,
  ApprovalItem,
  EntityConflictContext,
  EntityConflictResolutionRequest,
  HumanDispositionFeedbackInput,
  SettledApprovalItem,
} from '@cat-cafe/shared';
import { create } from 'zustand';
import { approvalFeatureMeta, isApprovalItemBatchDecidable } from '@/lib/approval-features';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';

/**
 * Per-feature endpoint routing for approve/reject actions. Dedicated decision
 * routes live in the exhaustive client registry; all others use the default.
 */
/** Default endpoint for features without a dedicated decision route. */
const DEFAULT_ENDPOINT_BASE = '/api/dispatch-proposals';

function resolveEndpoint(
  featureId: ApprovalFeatureId | undefined,
  proposalId: string,
  action: 'approve' | 'reject',
): string {
  const base = (featureId && approvalFeatureMeta(featureId).decisionEndpointBase) ?? DEFAULT_ENDPOINT_BASE;
  return `${base}/${proposalId}/${action}`;
}

/** Result of a batch operation for a single item. */
interface BatchItemResult {
  proposalId: string;
  success: boolean;
  error?: string;
}

interface DecisionErrorBody {
  error?: string;
  detail?: string;
  message?: string;
  conflict?: EntityConflictContext | null;
}

interface EntityResolutionSuccessBody {
  proposalId: string;
  entityId: string;
  status: 'approved';
}

const ENTITY_RESOLUTION_ACTION_LABELS: Record<EntityConflictResolutionRequest['action'], string> = {
  'merge-aliases': '合并别名',
  replace: '明确替换',
  correct: '纠错归并',
  transfer: '转移归属',
  polysemy: '多义并存',
};

function decisionErrorMessage(body: DecisionErrorBody, fallback: string): string {
  const summary = body.message ?? body.error ?? fallback;
  return body.detail ? `${summary}: ${body.detail}` : summary;
}

function stablePersonMemoryDecisionId(
  proposalId: string,
  action: 'approve' | 'not-now' | 'reject' | 'withdraw',
  selectedDraftIds: string[] = [],
): string {
  const input = `${proposalId}\0${action}\0${[...selectedDraftIds].sort().join('\0')}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `f276_${action.replace('-', '_')}_${(hash >>> 0).toString(16)}`;
}

function withoutDecision(deciding: ApprovalHubState['deciding'], proposalId: string): ApprovalHubState['deciding'] {
  const next = { ...deciding };
  delete next[proposalId];
  return next;
}

function applyConflictFeedback(
  items: ApprovalItem[],
  proposalId: string,
  conflict: EntityConflictContext,
  message: string,
): ApprovalItem[] {
  return items.map((item) =>
    item.proposalId === proposalId ? { ...item, detail: { ...item.detail, conflict, conflictError: message } } : item,
  );
}

interface ApprovalHubState {
  items: ApprovalItem[];
  count: number;
  isLoading: boolean;
  isOpen: boolean;
  error: string | null;
  /** Map of proposalId → 'approving' | 'rejecting' for optimistic UI feedback */
  deciding: Record<string, 'approving' | 'rejecting' | 'resolving' | 'deferring' | 'withdrawing'>;
  /** AC-D5: Set of selected proposalIds for batch operations */
  selectedIds: Set<string>;
  /** AC-D5: Results of the last batch operation (cleared on next batch) */
  batchResults: BatchItemResult[];
  /** F246 Phase F: Settled (approved|rejected) history items */
  settledItems: SettledApprovalItem[];
  settledIsLoading: boolean;
  settledError: string | null;
  fetchPending: () => Promise<void>;
  /** F246 Phase F: fetch settled history (approved|rejected proposals) */
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
      const data = (await res.json()) as { items: ApprovalItem[]; count: number };
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
      const data = (await res.json()) as { items: SettledApprovalItem[]; count: number };
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

  approveProposal: async (proposalId: string) => {
    set((s) => ({ deciding: { ...s.deciding, [proposalId]: 'approving' as const } }));
    try {
      const item = get().items.find((i) => i.proposalId === proposalId);
      const res = await apiFetch(resolveEndpoint(item?.sourceFeatureId, proposalId, 'approve'), { method: 'POST' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as DecisionErrorBody;
        const conflict = data.conflict;
        if (conflict) {
          const message = decisionErrorMessage(data, `Approve failed: ${res.status}`);
          set((state) => ({
            items: applyConflictFeedback(state.items, proposalId, conflict, message),
            error: null,
            deciding: { ...state.deciding, [proposalId]: undefined as never },
          }));
          return;
        }
        throw new Error(decisionErrorMessage(data, `Approve failed: ${res.status}`));
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

  rejectProposal: async (proposalId: string, feedback?: HumanDispositionFeedbackInput) => {
    set((s) => ({ deciding: { ...s.deciding, [proposalId]: 'rejecting' as const }, error: null }));
    try {
      const item = get().items.find((i) => i.proposalId === proposalId);
      const isPersonMemory = item?.sourceFeatureId === 'F276' && item.decisionMode === 'claim-select';
      const isSessionHandoff = item?.sourceFeatureId === 'F225';
      const feedbackRequest =
        isPersonMemory || isSessionHandoff
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ...(isPersonMemory ? { decisionId: stablePersonMemoryDecisionId(proposalId, 'reject') } : {}),
                ...(feedback ? { feedback } : {}),
              }),
            }
          : {};
      const res = await apiFetch(resolveEndpoint(item?.sourceFeatureId, proposalId, 'reject'), {
        method: 'POST',
        ...feedbackRequest,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as DecisionErrorBody;
        throw new Error(decisionErrorMessage(data, `Reject failed: ${res.status}`));
      }
      // Optimistic remove from items list
      set((s) => ({
        items: s.items.filter((i) => i.proposalId !== proposalId),
        count: Math.max(0, s.count - 1),
        deciding: withoutDecision(s.deciding, proposalId),
        error: null,
      }));
      return true;
    } catch (err) {
      set((s) => ({
        error: err instanceof Error ? err.message : 'Reject failed',
        deciding: withoutDecision(s.deciding, proposalId),
      }));
      return false;
    }
  },

  approvePersonMemory: async (proposalId, selectedDraftIds) => {
    const item = get().items.find((candidate) => candidate.proposalId === proposalId);
    if (item?.sourceFeatureId !== 'F276' || item.decisionMode !== 'claim-select' || selectedDraftIds.length === 0) {
      set({ error: 'Person memory approval requires an exact non-empty draft selection' });
      return;
    }
    const remainingDraftIds = new Set(
      Array.isArray(item.detail.remainingDraftIds)
        ? item.detail.remainingDraftIds.filter((value): value is string => typeof value === 'string')
        : [],
    );
    const exactSelection = [...new Set(selectedDraftIds)];
    if (exactSelection.some((draftId) => !remainingDraftIds.has(draftId))) {
      set({ error: 'Person memory approval selection is stale' });
      return;
    }

    set((state) => ({ deciding: { ...state.deciding, [proposalId]: 'approving' as const }, error: null }));
    try {
      const res = await apiFetch(`/api/person-memory-proposals/${proposalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selectedDraftIds: exactSelection,
          decisionId: stablePersonMemoryDecisionId(proposalId, 'approve', exactSelection),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as DecisionErrorBody;
        throw new Error(decisionErrorMessage(data, `Approve failed: ${res.status}`));
      }
      const data = (await res.json()) as {
        status: 'partially_materialized' | 'materialized';
        remainingDraftIds?: string[];
      };
      set((state) => {
        const nextDeciding = { ...state.deciding };
        delete nextDeciding[proposalId];
        if (data.status === 'materialized') {
          return {
            items: state.items.filter((candidate) => candidate.proposalId !== proposalId),
            count: Math.max(0, state.count - 1),
            deciding: nextDeciding,
          };
        }
        return {
          items: state.items.map((candidate) =>
            candidate.proposalId === proposalId
              ? {
                  ...candidate,
                  detail: {
                    ...candidate.detail,
                    remainingDraftIds: data.remainingDraftIds ?? [],
                  },
                }
              : candidate,
          ),
          deciding: nextDeciding,
        };
      });
    } catch (err) {
      set((state) => ({
        error: err instanceof Error ? err.message : 'Approve failed',
        deciding: withoutDecision(state.deciding, proposalId),
      }));
    }
  },

  notNowPersonMemory: async (proposalId) => {
    const item = get().items.find((candidate) => candidate.proposalId === proposalId);
    if (item?.sourceFeatureId !== 'F276' || item.decisionMode !== 'claim-select') {
      set({ error: 'Not-now is only available for person memory proposals' });
      return;
    }
    set((state) => ({ deciding: { ...state.deciding, [proposalId]: 'deferring' as const }, error: null }));
    try {
      const res = await apiFetch(`/api/person-memory-proposals/${proposalId}/not-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decisionId: stablePersonMemoryDecisionId(proposalId, 'not-now'),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as DecisionErrorBody;
        throw new Error(decisionErrorMessage(data, `Not-now failed: ${res.status}`));
      }
      set((state) => ({
        items: state.items.map((candidate) =>
          candidate.proposalId === proposalId
            ? { ...candidate, detail: { ...candidate.detail, candidateState: 'not_now' } }
            : candidate,
        ),
        deciding: withoutDecision(state.deciding, proposalId),
      }));
    } catch (err) {
      set((state) => ({
        error: err instanceof Error ? err.message : 'Not-now failed',
        deciding: withoutDecision(state.deciding, proposalId),
      }));
    }
  },

  withdrawPersonMemory: async (proposalId) => {
    const item = get().items.find((candidate) => candidate.proposalId === proposalId);
    if (item?.sourceFeatureId !== 'F276' || item.decisionMode !== 'claim-select') {
      set({ error: 'Withdraw is only available for person memory proposals' });
      return;
    }
    set((state) => ({ deciding: { ...state.deciding, [proposalId]: 'withdrawing' as const }, error: null }));
    try {
      const res = await apiFetch(`/api/person-memory-proposals/${proposalId}/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decisionId: stablePersonMemoryDecisionId(proposalId, 'withdraw'),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as DecisionErrorBody;
        throw new Error(decisionErrorMessage(data, `Withdraw failed: ${res.status}`));
      }
      set((state) => ({
        items: state.items.filter((candidate) => candidate.proposalId !== proposalId),
        count: Math.max(0, state.count - 1),
        deciding: withoutDecision(state.deciding, proposalId),
      }));
    } catch (err) {
      set((state) => ({
        error: err instanceof Error ? err.message : 'Withdraw failed',
        deciding: withoutDecision(state.deciding, proposalId),
      }));
    }
  },

  resolveEntityConflict: async (proposalId, resolution) => {
    set((state) => ({ deciding: { ...state.deciding, [proposalId]: 'resolving' as const } }));
    try {
      const res = await apiFetch(`/api/entity-proposals/${proposalId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(resolution),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as DecisionErrorBody;
        const conflict = data.conflict;
        if (conflict) {
          const message = decisionErrorMessage(data, `Resolution failed: ${res.status}`);
          set((state) => ({
            items: applyConflictFeedback(state.items, proposalId, conflict, message),
            error: null,
            deciding: { ...state.deciding, [proposalId]: undefined as never },
          }));
          return;
        }
        throw new Error(decisionErrorMessage(data, `Resolution failed: ${res.status}`));
      }
      const data = (await res.json()) as EntityResolutionSuccessBody;
      set((state) => ({
        items: state.items.filter((item) => item.proposalId !== proposalId),
        count: Math.max(0, state.count - 1),
        deciding: { ...state.deciding, [proposalId]: undefined as never },
      }));
      useToastStore.getState().addToast({
        type: 'success',
        title: `提案 ${data.proposalId} 已完成`,
        message: `${ENTITY_RESOLUTION_ACTION_LABELS[resolution.action]}已写入目标实体 ${data.entityId}；其他待处理提案仍会保留。`,
        duration: 6000,
      });
    } catch (err) {
      set((state) => ({
        error: err instanceof Error ? err.message : 'Resolution failed',
        deciding: { ...state.deciding, [proposalId]: undefined as never },
      }));
    }
  },

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
