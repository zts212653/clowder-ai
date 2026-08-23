import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
});

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

const searchHits = [
  {
    score: 1.0,
    sessionId: 's1',
    seq: 3,
    kind: 'event' as const,
    snippet: 'found the bug in handler',
    pointer: { eventNo: 42 },
  },
  { score: 0.8, sessionId: 's2', seq: 1, kind: 'digest' as const, snippet: 'review passed all checks', pointer: {} },
];

describe('SessionSearchTab', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.apiFetch.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderSearch(props = {}) {
    const { SessionSearchTab } = await import('../SessionSearchTab');
    const defaultProps = { threadId: 't1', onViewSession: vi.fn(), ...props };
    await act(async () => {
      root.render(React.createElement(SessionSearchTab, defaultProps));
    });
  }

  it('renders search form with input and submit button', async () => {
    await renderSearch();

    const input = container.querySelector('input[type="text"]');
    expect(input).toBeTruthy();
    const submitBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('搜索'));
    expect(submitBtn).toBeTruthy();
  });

  it('submits search and renders results', async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ hits: searchHits }),
    });

    await renderSearch();

    // Type query
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      nativeInputValueSetter?.call(input, 'bug');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Submit
    const submitBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('搜索'));
    await act(async () => {
      submitBtn?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(mocks.apiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/threads/t1/sessions/search?q=bug'));
    expect(container.textContent).toContain('found the bug in handler');
    expect(container.textContent).toContain('review passed all checks');
  });

  it('shows empty results message', async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    });

    await renderSearch();

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      nativeInputValueSetter?.call(input, 'nothing');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submitBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('搜索'));
    await act(async () => {
      submitBtn?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(container.textContent).toContain('无匹配结果');
  });

  it('clicking result calls onViewSession', async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ hits: [searchHits[0]] }),
    });

    const onViewSession = vi.fn();
    await renderSearch({ onViewSession });

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      nativeInputValueSetter?.call(input, 'bug');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submitBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('搜索'));
    await act(async () => {
      submitBtn?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const resultBtn = container.querySelector('[data-testid="search-result-session"]');
    expect(resultBtn).toBeTruthy();
    await act(async () => {
      resultBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onViewSession).toHaveBeenCalledWith('s1', 't1');
  });

  it('ignores a slow result from the previous thread after the thread changes', async () => {
    let resolveSearch!: (value: { ok: true; json: () => Promise<{ hits: typeof searchHits }> }) => void;
    const slowSearch = new Promise<{ ok: true; json: () => Promise<{ hits: typeof searchHits }> }>((resolve) => {
      resolveSearch = resolve;
    });
    mocks.apiFetch.mockReturnValueOnce(slowSearch);

    await renderSearch({ threadId: 'thread-a' });
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      nativeInputValueSetter?.call(input, 'stale');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    });

    const { SessionSearchTab } = await import('../SessionSearchTab');
    await act(async () => {
      root.render(React.createElement(SessionSearchTab, { threadId: 'thread-b', onViewSession: vi.fn() }));
    });
    await act(async () => {
      resolveSearch({ ok: true, json: async () => ({ hits: searchHits }) });
      await slowSearch;
    });

    expect(container.textContent).not.toContain('found the bug in handler');
    expect(container.querySelector('[data-testid="search-result-session"]')).toBeNull();
  });
});
