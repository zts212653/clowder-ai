import type { SettledApprovalItem } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';

vi.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: () => ({ currentThreadId: 'thread-current' }) },
}));

vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({
  pushThreadRouteWithHistory: vi.fn(),
}));

import { SettledHistoryCard } from '../SettledHistoryCard';

const TASTE_ITEM: SettledApprovalItem = {
  proposalId: 'taste-settled-1',
  sourceFeatureId: 'F221',
  navigation: anchoredApprovalNavigation('thread-taste'),
  requesterCatId: 'codex-sol',
  ownerUserId: 'user-1',
  status: 'approved',
  summary: 'Taste [visual-quality]: 平铺会越来越难管理',
  detail: {},
  decidedAt: Date.now() - 60_000,
  decidedBy: 'you',
  createdAt: Date.now() - 120_000,
};

describe('F246/F221 settled history label', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders the human label 品味 instead of the raw F221 id', async () => {
    await act(async () => {
      root.render(React.createElement(SettledHistoryCard, { item: TASTE_ITEM }));
    });

    const badge = container.querySelector('[data-testid="settled-card-feature-badge"]');
    expect(badge?.textContent).toBe('品味');
    expect(container.textContent).not.toContain('F221');
  });
});
