/**
 * F246 Phase D AC-D5: approvalHubStore batch operations — store-level tests.
 *
 * Proves: toggleSelection only selects inlineApprovable items,
 * selectAllInline excludes non-inline, clearSelection empties set.
 */

import type { ApprovalItem } from '@cat-cafe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock apiFetch for batch operation tests (batchApprove/batchReject call it)
vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}));

import { useApprovalHubStore } from '../approvalHubStore';

const NOW = Date.now();

function makeItem(overrides: Partial<ApprovalItem> & { proposalId: string }): ApprovalItem {
  return {
    sourceFeatureId: 'F193',
    sourceThreadId: 'thread-1',
    requesterCatId: 'opus',
    ownerUserId: 'user-1',
    status: 'pending',
    summary: 'test',
    detail: {},
    inlineApprovable: true,
    createdAt: NOW,
    ...overrides,
  };
}

describe('approvalHubStore — batch operations', () => {
  beforeEach(() => {
    // Reset store to known state
    useApprovalHubStore.setState({
      items: [
        makeItem({ proposalId: 'inline-1', inlineApprovable: true }),
        makeItem({ proposalId: 'inline-2', inlineApprovable: true }),
        makeItem({ proposalId: 'jump-1', inlineApprovable: false, sourceFeatureId: 'F128' }),
      ],
      count: 3,
      selectedIds: new Set<string>(),
      batchResults: [],
      deciding: {},
      error: null,
    });
  });

  it('toggleSelection: selects an inlineApprovable item', () => {
    useApprovalHubStore.getState().toggleSelection('inline-1');
    expect(useApprovalHubStore.getState().selectedIds.has('inline-1')).toBe(true);
  });

  it('toggleSelection: deselects on second call', () => {
    useApprovalHubStore.getState().toggleSelection('inline-1');
    useApprovalHubStore.getState().toggleSelection('inline-1');
    expect(useApprovalHubStore.getState().selectedIds.has('inline-1')).toBe(false);
  });

  it('toggleSelection: refuses non-inlineApprovable items', () => {
    useApprovalHubStore.getState().toggleSelection('jump-1');
    expect(useApprovalHubStore.getState().selectedIds.has('jump-1')).toBe(false);
    expect(useApprovalHubStore.getState().selectedIds.size).toBe(0);
  });

  it('selectAllInline: selects only inlineApprovable items', () => {
    useApprovalHubStore.getState().selectAllInline();
    const ids = useApprovalHubStore.getState().selectedIds;
    expect(ids.has('inline-1')).toBe(true);
    expect(ids.has('inline-2')).toBe(true);
    expect(ids.has('jump-1')).toBe(false);
    expect(ids.size).toBe(2);
  });

  it('selectAllInline with visibleIds: only selects visible inline items', () => {
    useApprovalHubStore.setState({
      items: [
        makeItem({ proposalId: 'vis-1', inlineApprovable: true, sourceFeatureId: 'F193' }),
        makeItem({ proposalId: 'vis-2', inlineApprovable: true, sourceFeatureId: 'F193' }),
        makeItem({ proposalId: 'hidden-1', inlineApprovable: true, sourceFeatureId: 'F225' }),
        makeItem({ proposalId: 'jump-vis', inlineApprovable: false, sourceFeatureId: 'F193' }),
      ],
      count: 4,
      selectedIds: new Set<string>(),
      batchResults: [],
      deciding: {},
      error: null,
    });

    // visibleIds simulates filtered items: only vis-1, vis-2, jump-vis are visible
    useApprovalHubStore.getState().selectAllInline(['vis-1', 'vis-2', 'jump-vis']);
    const ids = useApprovalHubStore.getState().selectedIds;
    expect(ids.has('vis-1')).toBe(true);
    expect(ids.has('vis-2')).toBe(true);
    expect(ids.has('hidden-1')).toBe(false); // filtered out, not visible
    expect(ids.has('jump-vis')).toBe(false); // visible but not inlineApprovable
    expect(ids.size).toBe(2);
  });

  it('selectAllInline without visibleIds: selects all inline (backward compat)', () => {
    useApprovalHubStore.getState().selectAllInline();
    const ids = useApprovalHubStore.getState().selectedIds;
    expect(ids.has('inline-1')).toBe(true);
    expect(ids.has('inline-2')).toBe(true);
    expect(ids.has('jump-1')).toBe(false);
    expect(ids.size).toBe(2);
  });

  it('clearSelection: empties the set', () => {
    useApprovalHubStore.getState().selectAllInline();
    expect(useApprovalHubStore.getState().selectedIds.size).toBe(2);
    useApprovalHubStore.getState().clearSelection();
    expect(useApprovalHubStore.getState().selectedIds.size).toBe(0);
  });

  // P2 cloud review: double-click guard — selectedIds must clear before async loop
  it('batchApprove: clears selectedIds immediately (double-click guard)', async () => {
    useApprovalHubStore.getState().selectAllInline();
    expect(useApprovalHubStore.getState().selectedIds.size).toBe(2);

    // Start batch — selectedIds should be cleared in the synchronous set()
    // before any async API calls begin (prevents double-click re-entry)
    const promise = useApprovalHubStore.getState().batchApprove();
    expect(useApprovalHubStore.getState().selectedIds.size).toBe(0);

    await promise;
  });

  it('batchReject: clears selectedIds immediately (double-click guard)', async () => {
    useApprovalHubStore.getState().selectAllInline();
    expect(useApprovalHubStore.getState().selectedIds.size).toBe(2);

    const promise = useApprovalHubStore.getState().batchReject();
    expect(useApprovalHubStore.getState().selectedIds.size).toBe(0);

    await promise;
  });
});
