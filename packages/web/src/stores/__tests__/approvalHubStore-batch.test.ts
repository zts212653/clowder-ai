/**
 * F246 Phase D AC-D5: approvalHubStore batch operations — store-level tests.
 *
 * Proves: toggleSelection only selects inlineApprovable items,
 * selectAllInline excludes non-inline, clearSelection empties set.
 */

import type { ApprovalHubItem } from '@cat-cafe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';
import { apiFetch } from '@/utils/api-client';

// Mock apiFetch for batch operation tests (batchApprove/batchReject call it)
vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}));

import { useApprovalHubStore } from '../approvalHubStore';

const NOW = Date.now();

function makeItem(overrides: Partial<ApprovalHubItem> & { proposalId: string }): ApprovalHubItem {
  return {
    sourceFeatureId: 'F193',
    navigation: anchoredApprovalNavigation('thread-1'),
    requesterCatId: 'opus',
    ownerUserId: 'user-1',
    resolution: 'open',
    materialization: { state: 'not_started' },
    summary: 'test',
    detail: {},
    inlineApprovable: true,
    createdAt: NOW,
    ...overrides,
  };
}

describe('approvalHubStore — batch operations', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);
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
      scheduleDriftBlocked: {},
    });
  });
  it.each([
    'single',
    'batch',
  ])('remembers typed schedule drift from %s across entry points while allowing rejection', async (entry) => {
    const item = makeItem({ proposalId: 'schedule-drift', sourceFeatureId: 'F139' });
    useApprovalHubStore.setState({ items: [item], count: 1, selectedIds: new Set([item.proposalId]) });
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ code: 'SCHEDULE_TASK_DRIFT', error: 'Task changed' }),
    } as Response);
    if (entry === 'single') await useApprovalHubStore.getState().approveProposal(item.proposalId);
    else {
      const failed = await useApprovalHubStore.getState().batchApprove();
      expect(failed).toEqual([
        { proposalId: item.proposalId, success: false, code: 'SCHEDULE_TASK_DRIFT', error: 'Task changed' },
      ]);
    }
    useApprovalHubStore.setState({ selectedIds: new Set([item.proposalId]) });
    expect(await useApprovalHubStore.getState().batchApprove()).toEqual([]);
    await useApprovalHubStore.getState().approveProposal(item.proposalId);
    expect(useApprovalHubStore.getState().error).toBeNull();
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1);
    await useApprovalHubStore.getState().batchReject();
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(apiFetch).mock.calls.at(-1)?.[0]).toBe('/api/schedule-proposals/schedule-drift/reject');
  });
  it('does not apply a witnessed schedule conflict to another owner, version or producer', async () => {
    const item = makeItem({ proposalId: 'shared-id', sourceFeatureId: 'F139' });
    useApprovalHubStore.getState().rememberScheduleDrift(item);
    for (const other of [
      { ...item, ownerUserId: 'other' },
      { ...item, createdAt: item.createdAt + 1 },
      { ...item, sourceFeatureId: 'F193' as const },
    ]) {
      useApprovalHubStore.setState({ items: [other], selectedIds: new Set([other.proposalId]) });
      expect((await useApprovalHubStore.getState().batchApprove())[0]?.success).toBe(true);
    }
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(3);
  });

  it('toggleSelection: selects an inlineApprovable item', () => {
    useApprovalHubStore.getState().toggleSelection('inline-1');
    expect(useApprovalHubStore.getState().selectedIds.has('inline-1')).toBe(true);
  });

  it('keeps each selected Taste digest when the live store changes during a batch', async () => {
    const first = makeItem({
      proposalId: 'taste-first',
      sourceFeatureId: 'F221',
      detail: { decisionDigest: 'a'.repeat(64) },
    });
    const second = makeItem({
      proposalId: 'taste-second',
      sourceFeatureId: 'F221',
      detail: { decisionDigest: 'b'.repeat(64) },
    });
    useApprovalHubStore.setState({
      items: [first, second],
      selectedIds: new Set([first.proposalId, second.proposalId]),
      count: 2,
    });
    vi.mocked(apiFetch).mockImplementationOnce(async () => {
      useApprovalHubStore.setState({ items: [first, { ...second, detail: { decisionDigest: 'c'.repeat(64) } }] });
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    await useApprovalHubStore.getState().batchApprove();
    expect(vi.mocked(apiFetch).mock.calls[0][1]?.body).toBe(JSON.stringify({ decisionDigest: 'a'.repeat(64) }));
    expect(vi.mocked(apiFetch).mock.calls[1][1]?.body).toBe(JSON.stringify({ decisionDigest: 'b'.repeat(64) }));
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

  it('accepted outcome_unknown items cannot enter approve/reject batch selection', async () => {
    useApprovalHubStore.setState({
      items: [
        makeItem({
          proposalId: 'taste-recovery',
          sourceFeatureId: 'F221',
          resolution: 'accepted',
          materialization: { state: 'outcome_unknown' },
        } as Partial<ApprovalHubItem> & { proposalId: string }),
      ],
      count: 1,
      selectedIds: new Set<string>(),
      batchResults: [],
      deciding: {},
      error: null,
    });

    useApprovalHubStore.getState().toggleSelection('taste-recovery');
    useApprovalHubStore.getState().selectAllInline();
    expect(useApprovalHubStore.getState().selectedIds.size).toBe(0);

    useApprovalHubStore.setState({ selectedIds: new Set(['taste-recovery']) });
    expect(await useApprovalHubStore.getState().batchApprove()).toEqual([]);
    expect(await useApprovalHubStore.getState().batchReject()).toEqual([]);
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
