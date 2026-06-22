/**
 * F246 Phase D AC-D5: ApprovalPanel batch approve/reject tests.
 *
 * Proves: batch bar visibility, select all inline, batch approve/reject
 * calls, non-inline items excluded, clear selection.
 */

import type { ApprovalItem } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock data ---
const NOW = Date.now();
const SAMPLE_ITEMS: ApprovalItem[] = [
  {
    proposalId: 'dp-inline-1',
    sourceFeatureId: 'F193',
    sourceThreadId: 'thread-1',
    requesterCatId: 'opus',
    ownerUserId: 'user-1',
    status: 'pending',
    summary: 'Inline item A',
    detail: {},
    inlineApprovable: true,
    createdAt: NOW,
  },
  {
    proposalId: 'dp-inline-2',
    sourceFeatureId: 'F193',
    sourceThreadId: 'thread-2',
    requesterCatId: 'sonnet',
    ownerUserId: 'user-1',
    status: 'pending',
    summary: 'Inline item B',
    detail: {},
    inlineApprovable: true,
    createdAt: NOW,
  },
  {
    proposalId: 'dp-jump-1',
    sourceFeatureId: 'F128',
    sourceThreadId: 'thread-3',
    requesterCatId: 'opus',
    ownerUserId: 'user-1',
    status: 'pending',
    summary: 'Jump-only item C',
    detail: {},
    inlineApprovable: false,
    createdAt: NOW,
  },
];

let mockItems: ApprovalItem[] = [];
let mockCount = 0;
let mockIsLoading = false;
let mockError: string | null = null;
let mockSelectedIds = new Set<string>();
let mockBatchResults: Array<{ proposalId: string; success: boolean; error?: string }> = [];
const mockFetchPending = vi.fn();
const mockSelectAllInline = vi.fn(() => {
  mockSelectedIds = new Set(mockItems.filter((i) => i.inlineApprovable).map((i) => i.proposalId));
});
const mockClearSelection = vi.fn(() => {
  mockSelectedIds = new Set<string>();
});
const mockBatchApprove = vi.fn(async () => []);
const mockBatchReject = vi.fn(async () => []);
const mockToggleSelection = vi.fn();

vi.mock('@/stores/approvalHubStore', () => ({
  useApprovalHubStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      items: mockItems,
      count: mockCount,
      isLoading: mockIsLoading,
      error: mockError,
      fetchPending: mockFetchPending,
      selectedIds: mockSelectedIds,
      selectAllInline: mockSelectAllInline,
      clearSelection: mockClearSelection,
      batchApprove: mockBatchApprove,
      batchReject: mockBatchReject,
      toggleSelection: mockToggleSelection,
      batchResults: mockBatchResults,
    }),
}));

vi.mock('@/components/ApprovalItemCard', () => ({
  ApprovalItemCard: ({ item }: { item: { proposalId: string } }) =>
    React.createElement('div', { 'data-testid': `approval-card-${item.proposalId}` }, item.proposalId),
}));

import { ApprovalPanel } from '../ApprovalPanel';

describe('F246 AC-D5: ApprovalPanel batch operations', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    mockItems = [...SAMPLE_ITEMS];
    mockCount = SAMPLE_ITEMS.length;
    mockIsLoading = false;
    mockError = null;
    mockSelectedIds = new Set<string>();
    mockBatchResults = [];
    mockFetchPending.mockClear();
    mockSelectAllInline.mockClear();
    mockClearSelection.mockClear();
    mockBatchApprove.mockClear();
    mockBatchReject.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('batch bar renders when inlineApprovable items exist', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    const batchBar = container.querySelector('[data-testid="approval-batch-bar"]');
    expect(batchBar).not.toBeNull();
  });

  it('batch bar hidden when no inlineApprovable items', async () => {
    mockItems = [SAMPLE_ITEMS[2]]; // only jump-only item
    mockCount = 1;
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    const batchBar = container.querySelector('[data-testid="approval-batch-bar"]');
    expect(batchBar).toBeNull();
  });

  it('select toggle shows "全选可操作" when nothing selected', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    const toggle = container.querySelector('[data-testid="approval-batch-select-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.textContent).toContain('全选可操作');
  });

  it('clicking "全选可操作" calls selectAllInline', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    const toggle = container.querySelector('[data-testid="approval-batch-select-toggle"]');
    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockSelectAllInline).toHaveBeenCalledTimes(1);
  });

  it('when items are selected: shows count and approve/reject buttons', async () => {
    mockSelectedIds = new Set(['dp-inline-1', 'dp-inline-2']);
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    const toggle = container.querySelector('[data-testid="approval-batch-select-toggle"]');
    expect(toggle?.textContent).toContain('取消选择');
    expect(toggle?.textContent).toContain('2');

    expect(container.querySelector('[data-testid="approval-batch-approve"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="approval-batch-reject"]')).not.toBeNull();
  });

  it('approve/reject buttons hidden when nothing selected', async () => {
    mockSelectedIds = new Set();
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    expect(container.querySelector('[data-testid="approval-batch-approve"]')).toBeNull();
    expect(container.querySelector('[data-testid="approval-batch-reject"]')).toBeNull();
  });

  it('batch approve button calls batchApprove', async () => {
    mockSelectedIds = new Set(['dp-inline-1']);
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    const approveBtn = container.querySelector('[data-testid="approval-batch-approve"]');
    await act(async () => {
      approveBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockBatchApprove).toHaveBeenCalledTimes(1);
  });

  it('batch reject button calls batchReject', async () => {
    mockSelectedIds = new Set(['dp-inline-1']);
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    const rejectBtn = container.querySelector('[data-testid="approval-batch-reject"]');
    await act(async () => {
      rejectBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockBatchReject).toHaveBeenCalledTimes(1);
  });

  it('clicking "取消选择" calls clearSelection', async () => {
    mockSelectedIds = new Set(['dp-inline-1']);
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    // Reset mock after initial render (useEffect clears selection on mount)
    mockClearSelection.mockClear();

    const toggle = container.querySelector('[data-testid="approval-batch-select-toggle"]');
    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockClearSelection).toHaveBeenCalledTimes(1);
  });

  it('clears selection when feature filter changes', async () => {
    mockSelectedIds = new Set(['dp-inline-1', 'dp-inline-2']);
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    // Click a feature filter chip (e.g. F128) — testid is approval-filter-feature-{key}
    const filterChip = container.querySelector('[data-testid="approval-filter-feature-F128"]');
    expect(filterChip).not.toBeNull();
    await act(async () => {
      filterChip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Selection should be cleared when filter changes
    expect(mockClearSelection).toHaveBeenCalled();
  });

  it('shows batch failure banner with per-item details when batchResults has errors', async () => {
    mockBatchResults = [
      { proposalId: 'dp-inline-1', success: true },
      { proposalId: 'dp-inline-2', success: false, error: 'CAS conflict' },
    ];
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    const banner = container.querySelector('[data-testid="approval-batch-results"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('1');
    expect(banner?.textContent).toContain('失败');

    // Per-item failure detail
    const failItem = container.querySelector('[data-testid="batch-fail-dp-inline-2"]');
    expect(failItem).not.toBeNull();
    expect(failItem?.textContent).toContain('CAS conflict');
  });

  it('no batch failure banner when batchResults is empty', async () => {
    mockBatchResults = [];
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    const banner = container.querySelector('[data-testid="approval-batch-results"]');
    expect(banner).toBeNull();
  });

  it('no batch failure banner when all batch results succeed', async () => {
    mockBatchResults = [
      { proposalId: 'dp-inline-1', success: true },
      { proposalId: 'dp-inline-2', success: true },
    ];
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    const banner = container.querySelector('[data-testid="approval-batch-results"]');
    expect(banner).toBeNull();
  });

  it('batch bar hidden when filtered view has no inlineApprovable items', async () => {
    // Setup: F193 items are inline, F128 item is jump-only
    // (uses SAMPLE_ITEMS from beforeEach: dp-inline-1/2 are F193 inline, dp-jump-1 is F128 jump)
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    // Batch bar should be visible initially (F193 inline items exist)
    expect(container.querySelector('[data-testid="approval-batch-bar"]')).not.toBeNull();

    // Click F128 filter — filtered view now contains only dp-jump-1 (not inlineApprovable)
    const filterChip = container.querySelector('[data-testid="approval-filter-feature-F128"]');
    expect(filterChip).not.toBeNull();
    await act(async () => {
      filterChip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Batch bar should be hidden: filtered view has 0 inlineApprovable items
    const batchBar = container.querySelector('[data-testid="approval-batch-bar"]');
    expect(batchBar).toBeNull();
  });
});
