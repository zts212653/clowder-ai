/**
 * F246 v2: ApprovalPanel F231 filter regression tests.
 *
 * Extracted from ApprovalPanel-filters.test.tsx (cloud review P1: file
 * exceeded 350-line hard limit). Proves F231 chip renders, has correct
 * label, and filters to only profile proposals.
 */

import type { ApprovalItem } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
const mockFetchPending = vi.fn();

vi.mock('@/stores/approvalHubStore', () => ({
  useApprovalHubStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      items: mockItems,
      count: mockCount,
      isLoading: false,
      error: null,
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

describe('F246 v2: ApprovalPanel F231 filter regression', () => {
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
    mockFetchPending.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders filter bar with F231 chip', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    expect(container.querySelector('[data-testid="approval-filter-feature-F231"]')).not.toBeNull();
  });

  it('F231 filter chip has label 画像', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    const f231Btn = container.querySelector('[data-testid="approval-filter-feature-F231"]');
    expect(f231Btn).not.toBeNull();
    expect(f231Btn!.textContent).toBe('画像');
  });

  it('F231 filter shows only profile proposals', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalPanel));
    });

    const f231Btn = container.querySelector('[data-testid="approval-filter-feature-F231"]');
    await act(async () => {
      f231Btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Only F231 items visible
    expect(container.querySelector('[data-testid="approval-card-dp-f231-1"]')).not.toBeNull();
    // Others hidden
    expect(container.querySelector('[data-testid="approval-card-dp-f128-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="approval-card-dp-f193-1"]')).toBeNull();
  });
});
