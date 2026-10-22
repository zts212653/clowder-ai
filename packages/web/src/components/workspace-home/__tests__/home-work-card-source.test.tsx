import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, json: async () => ({ content: 'WRONG CURRENT WORKTREE BODY' }) })),
);
vi.mock('@/utils/api-client', () => ({ API_URL: '', apiFetch }));

import { WorkCard } from '../HomeWorkCard';

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
      expect(host.querySelector('.home-work-label')?.textContent).toBe(expected);
      expect(host.querySelector('img')?.alt).toBe(expected);
      expect(host.querySelector('a[download]')?.getAttribute('download')).toBe(name);
    }
  } finally {
    act(() => {
      root.unmount();
      writeShellLanguage('zh');
    });
    vi.unstubAllGlobals();
  }
});

it('downloads the original asset and filename without opening its reader or forwarding cookies to an external asset', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const fetchAsset = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['image bytes']) }));
  vi.stubGlobal('fetch', fetchAsset);
  const createObjectURL = vi.fn(() => 'blob:download-sample');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    },
  );
  const downloads: { url: string; name: string }[] = [];
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ url: this.href, name: this.download });
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onSelect = vi.fn();
  try {
    for (const url of ['/uploads/exact-original.png', 'https://assets.example/image.png']) {
      await act(async () =>
        root.render(
          <WorkCard
            artifact={{ type: 'image', name: '原文件.png', url, catId: null, createdAt: 1, sourceMessageId: null }}
            summary={false}
            metadata=""
            worktreeId={null}
            onSelect={onSelect}
          />,
        ),
      );
      await act(async () =>
        host
          .querySelector<HTMLAnchorElement>('a[download]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
      );
    }
    expect(fetchAsset.mock.calls).toEqual([
      ['/uploads/exact-original.png', { credentials: 'include' }],
      ['https://assets.example/image.png', { credentials: 'same-origin' }],
    ]);
    expect(downloads).toEqual(Array(2).fill({ url: 'blob:download-sample', name: '原文件.png' }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
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
