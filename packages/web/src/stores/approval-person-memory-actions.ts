'use client';

/**
 * F276: the person-memory decision actions (approve a picked subset of drafts, not now, withdraw). Same contract as the
 * other decision actions: what they always did to `items`, `count`, `error` and `deciding`, plus a record of what the
 * request saw in `decisionAttempts`.
 */

import type { ApprovalHubItem } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';
import { beginDecisionAttempt, type DecisionActionKind } from './approval-decision-attempts';
import {
  type DecisionErrorBody,
  decisionErrorMessage,
  stablePersonMemoryDecisionId,
  withoutDecision,
} from './approval-decision-http';
import type { DecisionStoreSlice, SliceUpdate } from './approval-decision-types';

export interface PersonMemoryDecisionActions {
  approvePersonMemory: (proposalId: string, selectedDraftIds: string[]) => Promise<void>;
  notNowPersonMemory: (proposalId: string) => Promise<void>;
  withdrawPersonMemory: (proposalId: string) => Promise<void>;
}

export function createPersonMemoryDecisionActions(
  set: SliceUpdate,
  get: () => DecisionStoreSlice,
): PersonMemoryDecisionActions {
  const findItem = (proposalId: string) => get().items.find((candidate) => candidate.proposalId === proposalId);

  /** The card refuses before sending anything: say why, as both the attempt and the global error. */
  const refuse = (
    proposalId: string,
    action: DecisionActionKind,
    item: ApprovalHubItem | undefined,
    message: string,
  ) => {
    beginDecisionAttempt(set, proposalId, action, item).refused(message);
    set({ error: message });
  };

  return {
    approvePersonMemory: async (proposalId, selectedDraftIds) => {
      const item = findItem(proposalId);
      if (item?.sourceFeatureId !== 'F276' || item.decisionMode !== 'claim-select' || selectedDraftIds.length === 0) {
        refuse(
          proposalId,
          'person-memory-approve',
          item,
          'Person memory approval requires an exact non-empty draft selection',
        );
        return;
      }
      const remainingDraftIds = new Set(
        Array.isArray(item.detail.remainingDraftIds)
          ? item.detail.remainingDraftIds.filter((value): value is string => typeof value === 'string')
          : [],
      );
      const exactSelection = [...new Set(selectedDraftIds)];
      if (exactSelection.some((draftId) => !remainingDraftIds.has(draftId))) {
        refuse(proposalId, 'person-memory-approve', item, 'Person memory approval selection is stale');
        return;
      }

      const attempt = beginDecisionAttempt(set, proposalId, 'person-memory-approve', item);
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
          attempt.received(res, data);
          throw new Error(decisionErrorMessage(data, `Approve failed: ${res.status}`));
        }
        attempt.received(res);
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
        attempt.failed(err);
        set((state) => ({
          error: err instanceof Error ? err.message : 'Approve failed',
          deciding: withoutDecision(state.deciding, proposalId),
        }));
      }
    },

    notNowPersonMemory: async (proposalId) => {
      const item = findItem(proposalId);
      if (item?.sourceFeatureId !== 'F276' || item.decisionMode !== 'claim-select') {
        refuse(proposalId, 'person-memory-not-now', item, 'Not-now is only available for person memory proposals');
        return;
      }
      const attempt = beginDecisionAttempt(set, proposalId, 'person-memory-not-now', item);
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
          attempt.received(res, data);
          throw new Error(decisionErrorMessage(data, `Not-now failed: ${res.status}`));
        }
        attempt.received(res);
        set((state) => ({
          items: state.items.map((candidate) =>
            candidate.proposalId === proposalId
              ? { ...candidate, detail: { ...candidate.detail, candidateState: 'not_now' } }
              : candidate,
          ),
          deciding: withoutDecision(state.deciding, proposalId),
        }));
      } catch (err) {
        attempt.failed(err);
        set((state) => ({
          error: err instanceof Error ? err.message : 'Not-now failed',
          deciding: withoutDecision(state.deciding, proposalId),
        }));
      }
    },

    withdrawPersonMemory: async (proposalId) => {
      const item = findItem(proposalId);
      if (item?.sourceFeatureId !== 'F276' || item.decisionMode !== 'claim-select') {
        refuse(proposalId, 'person-memory-withdraw', item, 'Withdraw is only available for person memory proposals');
        return;
      }
      const attempt = beginDecisionAttempt(set, proposalId, 'person-memory-withdraw', item);
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
          attempt.received(res, data);
          throw new Error(decisionErrorMessage(data, `Withdraw failed: ${res.status}`));
        }
        attempt.received(res);
        set((state) => ({
          items: state.items.filter((candidate) => candidate.proposalId !== proposalId),
          count: Math.max(0, state.count - 1),
          deciding: withoutDecision(state.deciding, proposalId),
        }));
      } catch (err) {
        attempt.failed(err);
        set((state) => ({
          error: err instanceof Error ? err.message : 'Withdraw failed',
          deciding: withoutDecision(state.deciding, proposalId),
        }));
      }
    },
  };
}
