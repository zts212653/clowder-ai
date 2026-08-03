import type { SettledApprovalItem } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';

const NOW = Date.now();
const SETTLED_ITEMS: SettledApprovalItem[] = [
  {
    proposalId: 'taste-1',
    sourceFeatureId: 'F221',
    navigation: anchoredApprovalNavigation('thread-taste'),
    requesterCatId: 'codex-sol',
    ownerUserId: 'user-1',
    status: 'approved',
    summary: 'Taste proposal',
    detail: {},
    createdAt: NOW - 2_000,
    decidedAt: NOW - 1_000,
    decidedBy: 'user-1',
  },
  {
    proposalId: 'dispatch-1',
    sourceFeatureId: 'F193',
    navigation: anchoredApprovalNavigation('thread-dispatch'),
    requesterCatId: 'opus',
    ownerUserId: 'user-1',
    status: 'rejected',
    summary: 'Dispatch proposal',
    detail: {},
    createdAt: NOW - 4_000,
    decidedAt: NOW - 3_000,
    decidedBy: 'user-1',
  },
];

const mockFetchPending = vi.fn();
const mockFetchSettled = vi.fn();

vi.mock('@/stores/approvalHubStore', () => ({
  useApprovalHubStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      items: [],
      count: 0,
      isLoading: false,
      error: null,
      fetchPending: mockFetchPending,
      settledItems: SETTLED_ITEMS,
      settledIsLoading: false,
      settledError: null,
      fetchSettled: mockFetchSettled,
      selectedIds: new Set<string>(),
      selectAllInline: vi.fn(),
      clearSelection: vi.fn(),
      batchApprove: vi.fn(),
      batchReject: vi.fn(),
      batchResults: [],
    }),
}));

vi.mock('@/components/SettledHistoryCard', () => ({
  SettledHistoryCard: ({ item }: { item: SettledApprovalItem }) =>
    React.createElement('div', { 'data-testid': `settled-card-${item.proposalId}` }, item.summary),
}));

import { ApprovalPanel } from '../ApprovalPanel';

describe('F246 history inbox integration', () => {
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
    mockFetchPending.mockClear();
    mockFetchSettled.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('loads grouped history and exposes Taste in the compact type menu', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });
    await act(async () => {
      container
        .querySelector('[data-testid="approval-tab-history"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockFetchSettled).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="approval-history-group-今天"]')).not.toBeNull();

    await act(async () => {
      container
        .querySelector('[data-testid="approval-history-filter-feature-trigger"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const tasteOption = container.querySelector('[data-testid="approval-history-filter-feature-F221"]');
    expect(tasteOption?.textContent).toContain('品味');

    await act(async () => {
      tasteOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="settled-card-taste-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="settled-card-dispatch-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="approval-history-filter-active-F221"]')).not.toBeNull();
  });
});
