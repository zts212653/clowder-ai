import type { SignalArticle } from '@cat-cafe/shared';
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

  it('renders article rows and triggers onSelect on click', async () => {
    const onSelect = vi.fn<(article: SignalArticle) => void>();

    await act(async () => {
      root.render(
        React.createElement(SignalArticleList, {
          items: [createArticle()],
          selectedArticleId: null,
          onSelect,
        }),
      );
    });

    const row = container.querySelector('[role="button"]');
    expect(row).toBeTruthy();
    if (!row) return;

    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'article-1' }));
  });

  it('renders §3.12 empty state with icon when items is empty', async () => {
    const onSelect = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(SignalArticleList, {
          items: [],
          selectedArticleId: null,
          onSelect,
        }),
      );
    });

    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();

    const title = container.textContent;
    expect(title).toContain('当前筛选条件下没有文章');
  });
});
