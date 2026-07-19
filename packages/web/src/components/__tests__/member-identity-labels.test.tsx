import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AuthorizationCard } from '../AuthorizationCard';
import { SettledHistoryCard } from '../SettledHistoryCard';

const TEST_CATS = [{ id: 'cat-sol', displayName: '缅因猫', variantLabel: 'sol' }];

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: TEST_CATS,
    getCatById: (id: string) => TEST_CATS.find((cat) => cat.id === id),
  }),
}));

describe('Console member identity labels', () => {
  it('renders the runtime member name in permission cards', () => {
    const html = renderToStaticMarkup(
      <AuthorizationCard
        request={{
          requestId: 'auth-1',
          catId: 'cat-sol',
          threadId: 'thread-1',
          action: 'write',
          reason: '需要更新文件',
          createdAt: Date.now(),
        }}
        onRespond={vi.fn()}
      />,
    );

    expect(html).toContain('缅因猫（sol） 请求权限');
    expect(html).not.toContain('cat-sol 请求权限');
  });

  it('uses the same projection in settled approval history', () => {
    const html = renderToStaticMarkup(
      <SettledHistoryCard
        item={{
          proposalId: 'proposal-1',
          sourceFeatureId: 'F225',
          sourceThreadId: 'thread-1',
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

    expect(html).toContain('来自 <span class="font-medium">缅因猫（sol）</span>');
  });

  it('falls back to catId when the member is absent from the runtime roster', () => {
    const html = renderToStaticMarkup(
      <AuthorizationCard
        request={{
          requestId: 'auth-2',
          catId: 'cat-retired',
          threadId: 'thread-1',
          action: 'read',
          reason: '读取历史记录',
          createdAt: Date.now(),
        }}
        onRespond={vi.fn()}
      />,
    );

    expect(html).toContain('cat-retired 请求权限');
  });
});
