import type { SignalArticle, SignalArticleStatus } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignalArticleList } from '@/components/signals/SignalArticleList';

function createArticle(overrides: Partial<SignalArticle> = {}): SignalArticle {
  return {
    id: 'article-1',
    title: 'Signals launch update',
    url: 'https://example.com/signals/launch',
    source: 'anthropic-news',
    tier: 1,
    publishedAt: '2026-02-19T08:00:00.000Z',
    fetchedAt: '2026-02-19T08:10:00.000Z',
    status: 'inbox',
    tags: [],
    filePath: '/tmp/article-1.md',
    ...overrides,
  };
}

describe('SignalArticleList', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders status badge for each article status', async () => {
    const statuses: SignalArticleStatus[] = ['inbox', 'read', 'archived', 'starred'];
    const articles = statuses.map((status, i) => createArticle({ id: `article-${i}`, status }));
    const labelMap: Record<SignalArticleStatus, string> = {
      inbox: '收件箱',
      read: '已读',
      archived: '归档',
      starred: '收藏',
    };

    await act(async () => {
      root.render(
        React.createElement(SignalArticleList, {
          items: articles,
          selectedArticleId: null,
          onSelect: vi.fn(),
          onStatusChange: vi.fn<(id: string, s: SignalArticleStatus) => Promise<void>>().mockResolvedValue(undefined),
        }),
      );
    });

    const badges = container.querySelectorAll('[data-testid="signal-status-badge"]');
    expect(badges.length).toBe(4);
    for (const [i, status] of statuses.entries()) {
      expect(badges[i]?.textContent).toBe(labelMap[status]);
    }

    const starredBadge = badges[3]!;
    expect(starredBadge.className).toContain('text-conn-amber-text');
    expect(starredBadge.className).toContain('bg-conn-amber-bg');
  });

  it('does not render nested action buttons and keeps action click isolated', async () => {
    const onSelect = vi.fn<(article: SignalArticle) => void>();
    const onStatusChange = vi
      .fn<(articleId: string, status: SignalArticleStatus) => Promise<void>>()
      .mockResolvedValue(undefined);

    await act(async () => {
      root.render(
        React.createElement(SignalArticleList, {
          items: [createArticle()],
          selectedArticleId: null,
          onSelect,
          onStatusChange,
        }),
      );
    });

    const rowButtons = Array.from(container.querySelectorAll('button'));
    expect(rowButtons.length).toBe(2);

    const hasNestedButtons = rowButtons.some((button) => button.querySelector('button'));
    expect(hasNestedButtons).toBe(false);

    const readButton = rowButtons.find((button) => button.textContent?.includes('已读'));
    expect(readButton).toBeTruthy();
    if (!readButton) return;

    await act(async () => {
      readButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onStatusChange).toHaveBeenCalledWith('article-1', 'read');
    expect(onSelect).not.toHaveBeenCalled();
  });
});
