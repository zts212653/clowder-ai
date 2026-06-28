/**
 * F246 Phase D AC-D4: ApprovalPanel filter tests.
 *
 * Proves: feature filter, stale filter, thread search, combined filters,
 * empty-filtered state, and clear-all.
 */

import type { ApprovalItem } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock data ---
const NOW = Date.now();
const SAMPLE_ITEMS: ApprovalItem[] = [
  {
    proposalId: 'dp-f128-1',
    sourceFeatureId: 'F128',
    sourceThreadId: 'thread-abc',
    requesterCatId: 'opus',
    ownerUserId: 'user-1',
    status: 'pending',
    summary: 'Thread proposal A',
    detail: {},
    inlineApprovable: false,
    createdAt: NOW - 3600_000,
  },
  {
    proposalId: 'dp-f193-1',
    sourceFeatureId: 'F193',
    sourceThreadId: 'thread-xyz',
    requesterCatId: 'sonnet',
    ownerUserId: 'user-1',
    status: 'pending',
    summary: 'Dispatch proposal B',
    detail: {},
    inlineApprovable: true,
    createdAt: NOW - 1800_000,
  },
  {
    proposalId: 'dp-f225-1',
    sourceFeatureId: 'F225',
    sourceThreadId: 'thread-abc',
    requesterCatId: 'opus',
    ownerUserId: 'user-1',
    status: 'pending',
    summary: 'Session handoff C',
    detail: {},
    inlineApprovable: false,
    expiresAt: NOW - 60_000, // already expired → stale
    createdAt: NOW - 7200_000,
  },
  {
    proposalId: 'dp-f193-2',
    sourceFeatureId: 'F193',
    sourceThreadId: 'thread-def',
    requesterCatId: 'opus',
    ownerUserId: 'user-1',
    status: 'pending',
    summary: 'Dispatch proposal D',
    detail: {},
    inlineApprovable: true,
    expiresAt: NOW + 600_000, // not expired
    createdAt: NOW - 900_000,
  },
  {
    proposalId: 'dp-f231-1',
    sourceFeatureId: 'F231',
    sourceThreadId: 'thread-profile',
    requesterCatId: 'opus',
    ownerUserId: 'user-1',
    status: 'pending',
    summary: 'Profile update: user prefers dark mode',
    detail: {
      rationale: 'user prefers dark mode',
      targetLayer: 'preferences',
      targetPath: 'theme',
      signalKind: 'explicit',
    },
    inlineApprovable: false,
    createdAt: NOW - 600_000,
  },
];

let mockItems: ApprovalItem[] = [];
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

vi.mock('@/components/ApprovalItemCard', () => ({
  ApprovalItemCard: ({ item }: { item: { proposalId: string } }) =>
    React.createElement('div', { 'data-testid': `approval-card-${item.proposalId}` }, item.proposalId),
}));

import { ApprovalPanel } from '../ApprovalPanel';

describe('F246 AC-D4: ApprovalPanel filters', () => {
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
    mockFetchPending.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // F231 filter chip + label + filter behavior tests extracted to
  // ApprovalPanel-f231-filter.test.tsx (cloud review P1: file over 350-line limit)

  it('default: all items shown (no filter active)', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    // All 4 items should be visible
    for (const item of SAMPLE_ITEMS) {
      expect(container.querySelector(`[data-testid="approval-card-${item.proposalId}"]`)).not.toBeNull();
    }
  });

  it('feature filter: F193 shows only dispatch proposals', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    // Click F193 filter
    const f193Btn = container.querySelector('[data-testid="approval-filter-feature-F193"]');
    await act(async () => {
      f193Btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Only F193 items visible
    expect(container.querySelector('[data-testid="approval-card-dp-f193-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="approval-card-dp-f193-2"]')).not.toBeNull();
    // F128 and F225 hidden
    expect(container.querySelector('[data-testid="approval-card-dp-f128-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="approval-card-dp-f225-1"]')).toBeNull();
  });

  it('feature filter: reset to all', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    // Apply F128 filter
    const f128Btn = container.querySelector('[data-testid="approval-filter-feature-F128"]');
    await act(async () => {
      f128Btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="approval-card-dp-f193-1"]')).toBeNull();

    // Reset to all
    const allBtn = container.querySelector('[data-testid="approval-filter-feature-all"]');
    await act(async () => {
      allBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="approval-card-dp-f193-1"]')).not.toBeNull();
  });

  it('stale filter: shows only expired items', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    // Click stale filter
    const staleBtn = container.querySelector('[data-testid="approval-filter-stale"]');
    await act(async () => {
      staleBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Only dp-f225-1 has expiresAt < now
    expect(container.querySelector('[data-testid="approval-card-dp-f225-1"]')).not.toBeNull();
    // Others should be hidden (pending or not expired)
    expect(container.querySelector('[data-testid="approval-card-dp-f128-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="approval-card-dp-f193-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="approval-card-dp-f193-2"]')).toBeNull();
  });

  it('stale filter: toggle off returns to all', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    const staleBtn = container.querySelector('[data-testid="approval-filter-stale"]');
    // Toggle on
    await act(async () => {
      staleBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="approval-card-dp-f128-1"]')).toBeNull();

    // Toggle off
    await act(async () => {
      staleBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="approval-card-dp-f128-1"]')).not.toBeNull();
  });

  it('thread search: filters by sourceThreadId substring', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    const input = container.querySelector('[data-testid="approval-filter-thread"]') as HTMLInputElement;
    expect(input).not.toBeNull();

    // Type "xyz" → only thread-xyz item visible
    await act(async () => {
      // Simulate native input
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'xyz');
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="approval-card-dp-f193-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="approval-card-dp-f128-1"]')).toBeNull();
  });

  it('combined: feature + stale filters intersect', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    // F193 filter (2 items: dp-f193-1, dp-f193-2)
    const f193Btn = container.querySelector('[data-testid="approval-filter-feature-F193"]');
    await act(async () => {
      f193Btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Then stale filter — none of the F193 items are stale
    const staleBtn = container.querySelector('[data-testid="approval-filter-stale"]');
    await act(async () => {
      staleBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Nothing matches F193 + stale
    expect(container.querySelector('[data-testid="approval-empty-filtered"]')).not.toBeNull();
  });

  it('empty-filtered state shows distinct message (not global empty)', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    // Apply F225 filter first
    const f225Btn = container.querySelector('[data-testid="approval-filter-feature-F225"]');
    await act(async () => {
      f225Btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Search for a thread that doesn't exist in F225
    const input = container.querySelector('[data-testid="approval-filter-thread"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'nonexistent');
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Should show filtered-empty, not global-empty
    expect(container.querySelector('[data-testid="approval-empty-filtered"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="approval-empty-state"]')).toBeNull();
  });

  it('clear button resets all filters', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    // Apply F128 filter
    const f128Btn = container.querySelector('[data-testid="approval-filter-feature-F128"]');
    await act(async () => {
      f128Btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Clear button should appear
    const clearBtn = container.querySelector('[data-testid="approval-filter-clear"]');
    expect(clearBtn).not.toBeNull();

    await act(async () => {
      clearBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // All items visible again
    for (const item of SAMPLE_ITEMS) {
      expect(container.querySelector(`[data-testid="approval-card-${item.proposalId}"]`)).not.toBeNull();
    }
  });

  it('no clear button when no filters active', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    const clearBtn = container.querySelector('[data-testid="approval-filter-clear"]');
    expect(clearBtn).toBeNull();
  });
});
