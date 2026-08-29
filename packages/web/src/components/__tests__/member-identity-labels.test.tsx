import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';
import { SettledHistoryCard } from '../SettledHistoryCard';

const TEST_CATS = [{ id: 'cat-sol', displayName: '缅因猫', variantLabel: 'sol' }];

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: TEST_CATS,
    getCatById: (id: string) => TEST_CATS.find((cat) => cat.id === id),
  }),
}));

describe('Console member identity labels', () => {
  it('renders the runtime member name in settled approval history', () => {
    const html = renderToStaticMarkup(
      <SettledHistoryCard
        item={{
          proposalId: 'proposal-1',
          sourceFeatureId: 'F225',
          navigation: anchoredApprovalNavigation('thread-1'),
          requesterCatId: 'cat-sol',
          ownerUserId: 'user-1',
          status: 'approved',
          summary: '交接完成',
          detail: {},
          createdAt: Date.now() - 1_000,
          decidedAt: Date.now(),
          decidedBy: 'user-1',
        }}
      />,
    );

    expect(html).toContain('来自 缅因猫（sol）');
    expect(html).not.toContain('来自 cat-sol');
  });
});
