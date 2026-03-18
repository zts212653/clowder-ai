import type { SignalArticleStatus } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignalArticleDetail } from '@/components/signals/SignalArticleDetail';

describe('SignalArticleDetail', () => {
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

  it('renders original link + discuss entry + markdown + tag editing', async () => {
    const onStatusChange = vi
      .fn<(articleId: string, status: SignalArticleStatus) => Promise<void>>()
      .mockResolvedValue(undefined);
    const onTagsChange = vi
      .fn<(articleId: string, tags: readonly string[]) => Promise<void>>()
      .mockResolvedValue(undefined);

    await act(async () => {
      root.render(
        React.createElement(SignalArticleDetail, {
          isLoading: false,
          article: {
            id: 'article-1',
            title: 'Test Article',
            url: 'https://example.com/article',
            source: 'test-source',
            tier: 1,
            publishedAt: '2026-02-19T08:00:00.000Z',
            fetchedAt: '2026-02-19T08:01:00.000Z',
            status: 'inbox',
            tags: ['existing'],
            filePath: '/tmp/article-1.md',
            content: '**重点内容**',
          },
          onStatusChange,
          onTagsChange,
        }),
      );
    });

    const originalLink = container.querySelector('a[href="https://example.com/article"]');
    expect(originalLink).not.toBeNull();
    expect(originalLink?.textContent ?? '').toContain('打开原文');

    // "在对话中讨论" is now a button that POST /discuss to create a study thread
    const discussButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('在对话中讨论'),
    );
    expect(discussButton).not.toBeNull();

    const strongText = container.querySelector('strong');
    expect(strongText?.textContent).toContain('重点内容');

    const tagBadge = Array.from(container.querySelectorAll('span')).find((item) =>
      item.textContent?.includes('existing'),
    );
    expect(tagBadge).toBeTruthy();

    const tagInput = container.querySelector('input[placeholder="添加标签"]') as HTMLInputElement | null;
    expect(tagInput).not.toBeNull();
    if (!tagInput) {
      return;
    }
    tagInput.value = 'new-tag';
    tagInput.dispatchEvent(new Event('input', { bubbles: true }));
    tagInput.dispatchEvent(new Event('change', { bubbles: true }));

    const addButton = Array.from(container.querySelectorAll('button')).find((item) =>
      item.textContent?.includes('添加标签'),
    );
    expect(addButton).not.toBeNull();
    if (!addButton) {
      return;
    }

    await act(async () => {
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onTagsChange).toHaveBeenCalledWith('article-1', ['existing', 'new-tag']);
  });

  it('does not add tag on Enter during IME composition', async () => {
    const onStatusChange = vi
      .fn<(articleId: string, status: SignalArticleStatus) => Promise<void>>()
      .mockResolvedValue(undefined);
    const onTagsChange = vi
      .fn<(articleId: string, tags: readonly string[]) => Promise<void>>()
      .mockResolvedValue(undefined);

    await act(async () => {
      root.render(
        React.createElement(SignalArticleDetail, {
          isLoading: false,
          article: {
            id: 'article-1',
            title: 'Test Article',
            url: 'https://example.com/article',
            source: 'test-source',
            tier: 1,
            publishedAt: '2026-02-19T08:00:00.000Z',
            fetchedAt: '2026-02-19T08:01:00.000Z',
            status: 'inbox',
            tags: ['existing'],
            filePath: '/tmp/article-1.md',
            content: 'content',
          },
          onStatusChange,
          onTagsChange,
        }),
      );
    });

    const tagInput = container.querySelector('input[placeholder="添加标签"]') as HTMLInputElement;
    expect(tagInput).not.toBeNull();

    // Type a partial tag value
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(tagInput, '中文标签');
      tagInput.dispatchEvent(new Event('input', { bubbles: true }));
      tagInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Simulate Enter during IME composition (isComposing = true)
    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
      Object.defineProperty(event, 'isComposing', { value: true });
      tagInput.dispatchEvent(event);
    });

    expect(onTagsChange).not.toHaveBeenCalled();
  });
});
