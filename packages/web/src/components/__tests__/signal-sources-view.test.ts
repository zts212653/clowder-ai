import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignalSourcesView } from '@/components/signals/SignalSourcesView';

const mocks = vi.hoisted(() => ({
  fetchSignalSources: vi.fn(),
  updateSignalSource: vi.fn(),
  triggerSourceFetch: vi.fn(),
}));

vi.mock('@/utils/signals-api', () => ({
  fetchSignalSources: (...args: unknown[]) => mocks.fetchSignalSources(...args),
  updateSignalSource: (...args: unknown[]) => mocks.updateSignalSource(...args),
  triggerSourceFetch: (...args: unknown[]) => mocks.triggerSourceFetch(...args),
}));

describe('SignalSourcesView', () => {
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
    mocks.fetchSignalSources.mockReset();
    mocks.updateSignalSource.mockReset();
    mocks.triggerSourceFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders visit link for each source url', async () => {
    mocks.fetchSignalSources.mockResolvedValueOnce([
      {
        id: 'anthropic-news',
        name: 'Anthropic Newsroom',
        url: 'https://www.anthropic.com/news',
        tier: 1,
        category: 'official',
        enabled: true,
        fetch: { method: 'webpage' },
        schedule: { frequency: 'daily' },
      },
    ]);

    await act(async () => {
      root.render(React.createElement(SignalSourcesView));
    });
    await act(async () => {
      await Promise.resolve();
    });

    const visitLink = Array.from(container.querySelectorAll('a[href="https://www.anthropic.com/news"]')).find((item) =>
      item.textContent?.includes('访问'),
    );
    expect(visitLink).not.toBeNull();
    expect(visitLink?.textContent ?? '').toContain('访问');
  });

  const SAMPLE_SOURCE = {
    id: 'anthropic-news',
    name: 'Anthropic Newsroom',
    url: 'https://www.anthropic.com/news',
    tier: 1,
    category: 'official',
    enabled: true,
    fetch: { method: 'webpage' as const },
    schedule: { frequency: 'daily' as const },
  };

  async function renderWithSource() {
    mocks.fetchSignalSources.mockResolvedValueOnce([SAMPLE_SOURCE]);
    await act(async () => {
      root.render(React.createElement(SignalSourcesView));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  function findFetchButton(): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Fetch' || btn.textContent === '抓取中...',
    ) as HTMLButtonElement | undefined;
  }

  it('clicking Fetch button calls triggerSourceFetch with source id', async () => {
    let resolvePromise: (v: unknown) => void;
    const pending = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    mocks.triggerSourceFetch.mockReturnValueOnce(pending);

    await renderWithSource();

    const fetchBtn = findFetchButton();
    expect(fetchBtn).toBeDefined();
    expect(fetchBtn?.textContent).toBe('Fetch');

    await act(async () => {
      fetchBtn?.click();
    });

    expect(mocks.triggerSourceFetch).toHaveBeenCalledWith('anthropic-news');
    expect(fetchBtn?.textContent).toBe('抓取中...');

    await act(async () => {
      resolvePromise?.({
        summary: { fetchedArticles: 5, newArticles: 3, storedArticles: 3, duplicateArticles: 2, errors: [] },
      });
    });
  });

  it('shows success feedback after successful fetch', async () => {
    mocks.triggerSourceFetch.mockResolvedValueOnce({
      summary: { fetchedArticles: 5, newArticles: 3, storedArticles: 3, duplicateArticles: 2, errors: [] },
    });

    await renderWithSource();

    const fetchBtn = findFetchButton()!;
    await act(async () => {
      fetchBtn.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const feedback = container.textContent ?? '';
    expect(feedback).toContain('抓取 5 篇');
    expect(feedback).toContain('新增 3 篇');
    expect(feedback).toContain('去重 2 篇');
  });

  it('shows failure feedback when fetch throws', async () => {
    mocks.triggerSourceFetch.mockRejectedValueOnce(new Error('Network timeout'));

    await renderWithSource();

    const fetchBtn = findFetchButton()!;
    await act(async () => {
      fetchBtn.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const feedback = container.textContent ?? '';
    expect(feedback).toContain('Network timeout');
  });
});
