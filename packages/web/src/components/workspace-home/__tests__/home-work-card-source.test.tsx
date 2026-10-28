import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() =>
  vi.fn(async (url: string) =>
    url.endsWith('/file-info')
      ? new Response(JSON.stringify({ local: true, path: '/original/原文件.png' }))
      : new Response('original file bytes'),
  ),
);
vi.mock('@/utils/api-client', () => ({ API_URL: '', apiFetch }));

import { WorkCard } from '../HomeWorkCard';

beforeEach(() => {
  apiFetch.mockClear();
});

it('localizes untitled image cards while preserving authored names and download names', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const { writeShellLanguage } = await import('@/components/shell/shell-language');
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    for (const [language, name, expected] of [
      ['en', '图片', 'Image'],
      ['zh', '图片', '图片'],
      ['en', '我的图片.png', '我的图片.png'],
    ] as const) {
      await act(async () => {
        writeShellLanguage(language);
        root.render(
          <WorkCard
            artifact={{
              type: 'image',
              name,
              url: '/uploads/original.png',
              catId: null,
              createdAt: 1,
              sourceMessageId: null,
              publicationItem: { kind: 'content-block', index: 0 },
            }}
            summary={false}
            metadata="IMAGE"
            worktreeId={null}
            onSelect={vi.fn()}
          />,
        );
      });
      expect(host.querySelector('.work-gallery-title')?.textContent).toBe(expected);
      expect(host.querySelector('img')?.alt).toBe(expected);
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click());
      expect(host.querySelector('a[download]')?.getAttribute('download')).toBe(name);
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click());
    }
  } finally {
    act(() => {
      root.unmount();
      writeShellLanguage('zh');
    });
    vi.unstubAllGlobals();
  }
});

it('uses the shared download menu, retains exact names and never fetches or forwards credentials to an external asset', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const externalFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response('preview'));
  vi.stubGlobal('fetch', externalFetch);
  const createObjectURL = vi.fn(() => 'blob:original-file');
  const revokeObjectURL = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    onSelect = vi.fn();
  try {
    await act(async () =>
      root.render(
        <WorkCard
          artifact={{
            type: 'file',
            name: '原文件.md',
            url: '/uploads/exact-original.md',
            catId: null,
            createdAt: 1,
            sourceMessageId: null,
          }}
          summary
          metadata=""
          worktreeId={null}
          onSelect={onSelect}
        />,
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click());
    const item = host.querySelector<HTMLAnchorElement>('a[download]')!;
    expect(item.download).toBe('原文件.md');
    await act(async () => item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(apiFetch).toHaveBeenCalledWith('/uploads/exact-original.md');
    expect(click).toHaveBeenCalledOnce();
    await act(async () =>
      root.render(
        <WorkCard
          artifact={{
            type: 'file',
            name: '外部原文件.md',
            url: 'https://assets.example/original.md',
            catId: null,
            createdAt: 1,
            sourceMessageId: null,
          }}
          summary
          metadata=""
          worktreeId={null}
          onSelect={onSelect}
        />,
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click());
    const external = host.querySelector<HTMLAnchorElement>('a[download]')!;
    expect(external.href).toBe('https://assets.example/original.md');
    expect(external.download).toBe('外部原文件.md');
    expect(externalFetch.mock.calls.every((call) => call.length === 1)).toBe(true);
    externalFetch.mockClear();
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    // Observe the handler's prevention decision, then suppress jsdom's unsupported navigation.
    let intercepted: boolean | undefined;
    host.addEventListener(
      'click',
      (e) => {
        if (e.target === external) {
          intercepted = e.defaultPrevented;
          e.preventDefault();
        }
      },
      { once: true },
    );
    await act(async () => external.dispatchEvent(event));
    expect(intercepted).toBe(false);
    expect(externalFetch).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
    click.mockRestore();
    vi.unstubAllGlobals();
  }
});

it('does not resolve an old relative md artifact against the currently selected worktree', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <WorkCard
          artifact={{
            type: 'file',
            name: 'README.md',
            ref: 'README.md',
            fileLedgerRef: 'saved-origin-A',
            catId: null,
            createdAt: 1,
            sourceMessageId: null,
          }}
          summary={false}
          metadata=""
          worktreeId="current-B"
          onSelect={vi.fn()}
        />,
      ),
    );
    expect(apiFetch).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('WRONG CURRENT WORKTREE BODY');
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
