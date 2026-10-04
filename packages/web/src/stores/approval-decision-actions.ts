'use client';

/**
 * F246: the Approval Hub's generic decision actions (approve, reject, entity-conflict resolve), plus the composition of
 * every decision action the store spreads in. Split out of the store so the store stays the size of a store.
 *
 * Each action does what it always did to `items`, `count`, `error` and `deciding`, and additionally records what its
 * request saw in `decisionAttempts` (see approval-decision-attempts.ts). The global `error` string stays, so the Approval
 * Hub's own panel and the feedback dialog behave exactly as before; the attempt is an extra observation, not a replacement.
 */

import type { EntityConflictResolutionRequest, HumanDispositionFeedbackInput } from '@cat-cafe/shared';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { beginDecisionAttempt } from './approval-decision-attempts';
import {
  applyConflictFeedback,
  type DecisionErrorBody,
  decisionErrorMessage,
  ENTITY_RESOLUTION_ACTION_LABELS,
  type EntityResolutionSuccessBody,
  resolveEndpoint,
  stablePersonMemoryDecisionId,
  withoutDecision,
} from './approval-decision-http';
import type { DecisionStoreSlice, SliceUpdate } from './approval-decision-types';
import { createPersonMemoryDecisionActions, type PersonMemoryDecisionActions } from './approval-person-memory-actions';

export interface ApprovalDecisionActions extends PersonMemoryDecisionActions {
  approveProposal: (proposalId: string) => Promise<void>;
  /** Resolves true when the rejection was accepted. */
  rejectProposal: (proposalId: string, feedback?: HumanDispositionFeedbackInput) => Promise<boolean>;
  resolveEntityConflict: (proposalId: string, resolution: EntityConflictResolutionRequest) => Promise<void>;
}

export function createApprovalDecisionActions(
  set: SliceUpdate,
  get: () => DecisionStoreSlice,
): ApprovalDecisionActions {
  const findItem = (proposalId: string) => get().items.find((candidate) => candidate.proposalId === proposalId);

  return {
    ...createPersonMemoryDecisionActions(set, get),

    approveProposal: async (proposalId: string) => {
      const item = findItem(proposalId);
      const attempt = beginDecisionAttempt(set, proposalId, 'approve', item);
      set((s) => ({ deciding: { ...s.deciding, [proposalId]: 'approving' as const } }));
      try {
        const res = await apiFetch(resolveEndpoint(item?.sourceFeatureId, proposalId, 'approve'), { method: 'POST' });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as DecisionErrorBody;
          attempt.received(res, data);
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
        attempt.received(res);
        // Optimistic remove from items list
        set((s) => ({
          items: s.items.filter((i) => i.proposalId !== proposalId),
          count: Math.max(0, s.count - 1),
          deciding: { ...s.deciding, [proposalId]: undefined as never },
        }));
      } catch (err) {
        attempt.failed(err);
        set((s) => ({
          error: err instanceof Error ? err.message : 'Approve failed',
          deciding: { ...s.deciding, [proposalId]: undefined as never },
        }));
      }
    },

    rejectProposal: async (proposalId: string, feedback?: HumanDispositionFeedbackInput) => {
      const item = findItem(proposalId);
      const attempt = beginDecisionAttempt(set, proposalId, 'reject', item);
      set((s) => ({ deciding: { ...s.deciding, [proposalId]: 'rejecting' as const }, error: null }));
      try {
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
          attempt.received(res, data);
          throw new Error(decisionErrorMessage(data, `Reject failed: ${res.status}`));
        }
        attempt.received(res);
        // Optimistic remove from items list
        set((s) => ({
          items: s.items.filter((i) => i.proposalId !== proposalId),
          count: Math.max(0, s.count - 1),
          deciding: withoutDecision(s.deciding, proposalId),
          error: null,
        }));
        return true;
      } catch (err) {
        attempt.failed(err);
        set((s) => ({
          error: err instanceof Error ? err.message : 'Reject failed',
          deciding: withoutDecision(s.deciding, proposalId),
        }));
        return false;
      }
    },

    resolveEntityConflict: async (proposalId, resolution) => {
      const attempt = beginDecisionAttempt(set, proposalId, 'entity-resolve', findItem(proposalId));
      set((state) => ({ deciding: { ...state.deciding, [proposalId]: 'resolving' as const } }));
      try {
        const res = await apiFetch(`/api/entity-proposals/${proposalId}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(resolution),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as DecisionErrorBody;
          attempt.received(res, data);
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
        attempt.received(res);
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
        attempt.failed(err);
        set((state) => ({
          error: err instanceof Error ? err.message : 'Resolution failed',
          deciding: { ...state.deciding, [proposalId]: undefined as never },
        }));
      }
    },
  };
}
