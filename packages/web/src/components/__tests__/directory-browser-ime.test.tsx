import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectoryBrowser } from '@/components/ThreadSidebar/DirectoryBrowser';

const mockApiFetch = vi.fn(async (url: string) => {
  if (url.startsWith('/api/projects/browse')) {
    return {
      ok: true,
      json: async () => ({
        current: '/Users/orca',
        name: 'orca',
        parent: '/Users',
        homePath: '/Users/orca',
        entries: [],
      }),
    };
  }
  return { ok: true, json: async () => ({ current: '/Users/orca/new-folder' }) };
});

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: string[]) => mockApiFetch(args[0], args[1] as unknown as Record<string, unknown>),
}));

describe('DirectoryBrowser IME guard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('prevents Enter default and does not create folder while composing', async () => {
    await act(async () => {
      root.render(<DirectoryBrowser onSelect={vi.fn()} onCancel={vi.fn()} />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const newButton = Array.from(container.querySelectorAll('button')).find((btn) => btn.textContent?.includes('新建'));
    if (!newButton) throw new Error('Missing new folder button');

    await act(async () => {
      newButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const input = container.querySelector('input[placeholder="文件夹名称..."]') as HTMLInputElement | null;
    if (!input) throw new Error('Missing new folder input');

    await act(async () => {
      input.value = '测试目录';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });

    const initialCallCount = mockApiFetch.mock.calls.length;
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => {
      input.dispatchEvent(enter);
    });

    expect(enter.defaultPrevented).toBe(true);
    expect(mockApiFetch.mock.calls.length).toBe(initialCallCount);
  });
});
