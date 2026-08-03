import type { ApprovalFeatureId, SettledApprovalItem } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';

vi.mock('@/components/SettledHistoryCard', () => ({
  SettledHistoryCard: ({ item }: { item: SettledApprovalItem }) =>
    React.createElement('div', { 'data-testid': `settled-card-${item.proposalId}` }, item.summary),
}));

import { ApprovalHistoryList, groupSettledApprovals } from '../ApprovalHistoryList';

const NOW = new Date(2026, 6, 16, 12).getTime();

function settledItem(
  proposalId: string,
  decidedAt: number,
  sourceFeatureId: ApprovalFeatureId = 'F221',
): SettledApprovalItem {
  return {
    proposalId,
    sourceFeatureId,
    navigation: anchoredApprovalNavigation(`thread-${proposalId}`),
    requesterCatId: 'codex-sol',
    ownerUserId: 'user-1',
    status: 'approved',
    summary: proposalId,
    detail: {},
    createdAt: decidedAt - 1_000,
    decidedAt,
    decidedBy: 'user-1',
  };
}

describe('F246 scalable approval history', () => {
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('groups newest-first history into 今天、本周、更早', () => {
    const groups = groupSettledApprovals(
      [
        settledItem('older', NOW - 8 * 86_400_000),
        settledItem('today', NOW - 60 * 60_000),
        settledItem('week', NOW - 2 * 86_400_000),
      ],
      NOW,
    );

    expect(groups.map((group) => group.label)).toEqual(['今天', '本周', '更早']);
    expect(groups.flatMap((group) => group.items.map((item) => item.proposalId))).toEqual(['today', 'week', 'older']);
  });

  it('renders 30 rows first and reveals the remainder on demand', async () => {
    const items = Array.from({ length: 35 }, (_, index) => settledItem(`item-${index}`, NOW - index * 1_000));

    await act(async () => {
      root.render(React.createElement(ApprovalHistoryList, { items, now: NOW }));
    });

    expect(container.querySelectorAll('[data-testid^="settled-card-"]')).toHaveLength(30);
    const loadMore = container.querySelector('[data-testid="approval-history-load-more"]');
    expect(loadMore?.textContent).toContain('5');

    await act(async () => {
      loadMore?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelectorAll('[data-testid^="settled-card-"]')).toHaveLength(35);
    expect(container.querySelector('[data-testid="approval-history-load-more"]')).toBeNull();
  });
});
