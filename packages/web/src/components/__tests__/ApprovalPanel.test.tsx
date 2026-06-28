/**
 * F246 Phase D AC-D3: ApprovalPanel vitest regression tests.
 *
 * Proves: loading state, empty state, error state, item rendering,
 * refresh button calls fetchPending, and badge count display.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock approvalHubStore ---
let mockItems: Array<{ proposalId: string; summary?: string; [k: string]: unknown }> = [];
let mockCount = 0;
let mockIsLoading = false;
let mockError: string | null = null;
const mockFetchPending = vi.fn();

vi.mock('@/stores/approvalHubStore', () => ({
  useApprovalHubStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      items: mockItems,
      count: mockCount,
      isLoading: mockIsLoading,
      error: mockError,
      fetchPending: mockFetchPending,
      selectedIds: new Set<string>(),
      selectAllInline: vi.fn(),
      clearSelection: vi.fn(),
      batchApprove: vi.fn(),
      batchReject: vi.fn(),
      batchResults: [],
    }),
}));

// Mock ApprovalItemCard to avoid deep dependency tree
vi.mock('@/components/ApprovalItemCard', () => ({
  ApprovalItemCard: ({ item }: { item: { proposalId: string } }) =>
    React.createElement('div', { 'data-testid': `approval-card-${item.proposalId}` }, item.proposalId),
}));

import { ApprovalPanel } from '../ApprovalPanel';

describe('F246 AC-D3: ApprovalPanel', () => {
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
    mockItems = [];
    mockCount = 0;
    mockIsLoading = false;
    mockError = null;
    mockFetchPending.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders loading state when isLoading=true and no items', async () => {
    mockIsLoading = true;
    mockItems = [];
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    const panel = container.querySelector('[data-testid="approval-panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('加载中');
  });

  it('renders empty state when no items and not loading', async () => {
    mockIsLoading = false;
    mockItems = [];
    mockError = null;
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    const emptyState = container.querySelector('[data-testid="approval-empty-state"]');
    expect(emptyState).not.toBeNull();
    expect(emptyState?.textContent).toContain('没有待审批的项目');
  });

  it('renders error state', async () => {
    mockError = 'Network failed';
    mockIsLoading = false;
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    const panel = container.querySelector('[data-testid="approval-panel"]');
    expect(panel?.textContent).toContain('加载失败');
    expect(panel?.textContent).toContain('Network failed');
  });

  it('renders approval item cards when items present', async () => {
    mockItems = [
      { proposalId: 'dp-1', content: 'Fix bug' },
      { proposalId: 'dp-2', content: 'Review PR' },
    ];
    mockCount = 2;
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    const card1 = container.querySelector('[data-testid="approval-card-dp-1"]');
    const card2 = container.querySelector('[data-testid="approval-card-dp-2"]');
    expect(card1).not.toBeNull();
    expect(card2).not.toBeNull();
  });

  it('displays badge count when count > 0', async () => {
    mockCount = 5;
    mockItems = [{ proposalId: 'dp-1' }];
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    // The header should show the count badge
    const panel = container.querySelector('[data-testid="approval-panel"]');
    expect(panel?.textContent).toContain('5');
  });

  it('caps badge at 99+ for count > 99', async () => {
    mockCount = 150;
    mockItems = [{ proposalId: 'dp-1' }];
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    const panel = container.querySelector('[data-testid="approval-panel"]');
    expect(panel?.textContent).toContain('99+');
  });

  it('refresh button calls fetchPending', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    const refreshBtn = container.querySelector('[data-testid="approval-panel-refresh"]');
    expect(refreshBtn).not.toBeNull();

    await act(async () => {
      refreshBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockFetchPending).toHaveBeenCalledTimes(1);
  });

  it('does not show empty state when loading with no items', async () => {
    mockIsLoading = true;
    mockItems = [];
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    // Loading state should be shown, not empty state
    const emptyState = container.querySelector('[data-testid="approval-empty-state"]');
    expect(emptyState).toBeNull();
    expect(container.textContent).toContain('加载中');
  });

  it('no badge displayed when count is 0', async () => {
    mockCount = 0;
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    // The header should show "待审批" but no count badge
    const panel = container.querySelector('[data-testid="approval-panel"]');
    expect(panel?.textContent).toContain('待审批');
    // Should not have any numeric count visible (no badge span rendered)
    const badges = panel?.querySelectorAll('.rounded-full');
    const countBadges = Array.from(badges ?? []).filter((b) => b.textContent && /^\d+/.test(b.textContent));
    expect(countBadges.length).toBe(0);
  });
});
