import type { SignalArticle } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignalInboxView } from '@/components/signals/SignalInboxView';

const mocks = vi.hoisted(() => ({
  fetchSignalArticle: vi.fn(),
  fetchSignalSources: vi.fn(),
  fetchSignalStats: vi.fn(),
  fetchSignalsInbox: vi.fn(),
  searchSignals: vi.fn(),
  updateSignalArticle: vi.fn(),
}));

vi.mock('@/utils/signals-api', () => ({
  fetchSignalArticle: (...args: unknown[]) => mocks.fetchSignalArticle(...args),
  fetchSignalSources: (...args: unknown[]) => mocks.fetchSignalSources(...args),
  fetchSignalStats: (...args: unknown[]) => mocks.fetchSignalStats(...args),
  fetchSignalsInbox: (...args: unknown[]) => mocks.fetchSignalsInbox(...args),
  searchSignals: (...args: unknown[]) => mocks.searchSignals(...args),
  updateSignalArticle: (...args: unknown[]) => mocks.updateSignalArticle(...args),
  fetchCollections: () => Promise.resolve([]),
  createCollection: vi.fn(),
  updateCollection: vi.fn(),
  deleteSignalArticle: vi.fn(),
}));

vi.mock('@/components/signals/SignalArticleDetail', () => ({
  SignalArticleDetail: () => React.createElement('div', { 'data-testid': 'detail-panel' }),
}));

vi.mock('@/components/signals/SignalArticleList', () => ({
  SignalArticleList: () => React.createElement('div', { 'data-testid': 'article-list' }),
}));

vi.mock('@/components/signals/SignalNav', () => ({
  SignalNav: () => React.createElement('div', { 'data-testid': 'signal-nav' }),
}));

function createArticle(overrides: Partial<SignalArticle> = {}): SignalArticle {
  return {
    id: 'signal_1',
    url: 'https://example.com/post',
    title: 'Signals launch update',
    source: 'anthropic-news',
    tier: 1,
    publishedAt: '2026-02-19T08:00:00.000Z',
    fetchedAt: '2026-02-19T08:10:00.000Z',
    status: 'inbox',
    tags: [],
    filePath: '/tmp/signal_1.md',
    ...overrides,
  };
}

function setNativeValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
  descriptor?.set?.call(element, value);
}

describe('SignalInboxView', () => {
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

    const article = createArticle();
    mocks.fetchSignalArticle.mockReset();
    mocks.fetchSignalSources.mockReset();
    mocks.fetchSignalStats.mockReset();
    mocks.fetchSignalsInbox.mockReset();
    mocks.searchSignals.mockReset();
    mocks.updateSignalArticle.mockReset();

    mocks.fetchSignalSources.mockResolvedValue([{ name: 'anthropic-news', url: 'https://example.com' }]);
    mocks.fetchSignalsInbox.mockResolvedValue([article]);
    mocks.fetchSignalStats.mockResolvedValue({
      todayCount: 1,
      weekCount: 1,
      unreadCount: 1,
      byTier: { '1': 1 },
      bySource: { 'anthropic-news': 1 },
    });
    mocks.searchSignals.mockResolvedValue({ total: 1, items: [article] });
    mocks.fetchSignalArticle.mockResolvedValue({ ...article, content: 'body' });
    mocks.updateSignalArticle.mockResolvedValue({ ...article, content: 'body' });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('forwards active status/source/tier filters to server-side search', async () => {
    await act(async () => {
      root.render(React.createElement(SignalInboxView));
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const queryInput = container.querySelector('input[placeholder="搜索信号..."]');
    const selects = container.querySelectorAll('select');
    let statusSelect = selects.item(0) as HTMLSelectElement | null;
    let sourceSelect = selects.item(1) as HTMLSelectElement | null;
    let form = container.querySelector('form');

    expect(queryInput).not.toBeNull();
    expect(form).not.toBeNull();
    expect(statusSelect).not.toBeNull();
    expect(sourceSelect).not.toBeNull();

    if (!queryInput || !form || !statusSelect || !sourceSelect) {
      return;
    }

    const sourceOption = sourceSelect.querySelector('option[value="anthropic-news"]');
    expect(sourceOption).not.toBeNull();

    const statusEl = statusSelect;
    await act(async () => {
      statusEl.value = 'read';
      statusEl.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      setNativeValue(queryInput as HTMLInputElement, 'claude');
      queryInput.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    const refreshedSelects = container.querySelectorAll('select');
    statusSelect = refreshedSelects.item(0) as HTMLSelectElement | null;
    sourceSelect = refreshedSelects.item(1) as HTMLSelectElement | null;
    form = container.querySelector('form');
    expect(statusSelect).not.toBeNull();
    expect(sourceSelect).not.toBeNull();
    expect(form).not.toBeNull();
    if (!statusSelect || !sourceSelect || !form) {
      return;
    }

    await act(async () => {
      sourceSelect.value = 'anthropic-news';
      sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(sourceSelect.value).toBe('anthropic-news');

    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(mocks.searchSignals).toHaveBeenCalledWith('claude', {
      limit: 80,
      status: 'read',
      source: 'anthropic-news',
      tier: undefined,
    });
  });

  it('does not re-filter server search results on inbox page', async () => {
    await act(async () => {
      root.render(React.createElement(SignalInboxView));
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const contentOnlyMatchedArticle = createArticle({
      id: 'signal_2',
      title: 'General weekly update',
      url: 'https://example.com/general-update',
      tags: [],
      summary: undefined,
    });
    mocks.searchSignals.mockResolvedValueOnce({
      total: 1,
      items: [contentOnlyMatchedArticle],
    });

    const queryInput = container.querySelector('input[placeholder="搜索信号..."]');
    let form = container.querySelector('form');
    expect(queryInput).not.toBeNull();
    expect(form).not.toBeNull();
    if (!queryInput || !form) {
      return;
    }

    await act(async () => {
      setNativeValue(queryInput as HTMLInputElement, 'content-only-hit');
      queryInput.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    form = container.querySelector('form');
    expect(form).not.toBeNull();
    if (!form) {
      return;
    }

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Default status tab is 'inbox', which passes as-is to searchSignals
    expect(mocks.searchSignals).toHaveBeenCalledWith('content-only-hit', {
      limit: 80,
      source: undefined,
      status: 'inbox',
      tier: undefined,
    });
    expect(container.textContent).toContain('共 1 篇');
  });

  it('prevents Enter default while composing in search input', async () => {
    await act(async () => {
      root.render(React.createElement(SignalInboxView));
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const queryInput = container.querySelector('input[placeholder="搜索信号..."]') as HTMLInputElement | null;
    if (!queryInput) throw new Error('Missing query input');

    await act(async () => {
      queryInput.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => {
      queryInput.dispatchEvent(enter);
    });

    expect(enter.defaultPrevented).toBe(true);
  });
});
