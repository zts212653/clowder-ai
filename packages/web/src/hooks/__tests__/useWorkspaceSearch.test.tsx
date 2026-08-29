import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useWorkspaceSearch } from '../useWorkspaceSearch';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

let latestSearch: ReturnType<typeof useWorkspaceSearch>;

function HookHost() {
  latestSearch = useWorkspaceSearch('wt-main');
  return React.createElement('div');
}

describe('useWorkspaceSearch', () => {
  let container: HTMLDivElement;
  let root: Root;
  const apiFetchMock = vi.mocked(apiFetch);

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(HookHost));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    apiFetchMock.mockReset();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('combines filename and content matches for the launcher all-mode search', async () => {
    apiFetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { type: 'filename' | 'content' };
      const result =
        body.type === 'filename'
          ? { path: 'docs/F063.md', line: 0, content: '', contextBefore: '', contextAfter: '' }
          : { path: 'docs/F063.md', line: 12, content: '全文搜索', contextBefore: '', contextAfter: '' };
      return { ok: true, json: async () => ({ results: [result] }) } as Response;
    });

    await act(async () => {
      await latestSearch.search('F063', 'all');
    });

    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    expect(latestSearch.results.map((result) => result.matchType)).toEqual(['filename', 'content']);
  });

  it('does not let a completed stale request restore results after reset', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    apiFetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );

    let pendingSearch: Promise<void> | undefined;
    await act(async () => {
      pendingSearch = latestSearch.search('old query', 'content');
      await Promise.resolve();
    });
    act(() => latestSearch.reset());
    await act(async () => {
      resolveResponse?.({
        ok: true,
        json: async () => ({
          results: [{ path: 'old.md', line: 1, content: 'old', contextBefore: '', contextAfter: '' }],
        }),
      } as Response);
      await pendingSearch;
    });

    expect(latestSearch.results).toEqual([]);
    expect(latestSearch.loading).toBe(false);
  });
});
