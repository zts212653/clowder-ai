import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { F307FileOwnerSurface } from '../F307FileOwnerSurface';
import { createFileSurface } from '../real-surface-adapters';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('@/components/MarkdownContent', () => ({ MarkdownContent: () => null }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  writeShellPresentation('v2');
  mocks.apiFetch.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});

async function render(status: number, code: string, media = { path: 'master.mp4', mime: 'video/mp4' }) {
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/workspace/file?'))
      return new Response(
        JSON.stringify({
          path: media.path,
          mime: media.mime,
          binary: true,
          content: '',
          sha256: '',
          size: 322332174,
          truncated: false,
        }),
      );
    if (url === '/api/workspace/content-reviews/prepare')
      return new Response(JSON.stringify({ error: { code } }), { status });
    throw new Error(`unexpected route: ${url}`);
  });
  await act(async () => {
    root.render(
      <F307FileOwnerSurface
        surface={createFileSurface({ worktreeId: 'registered-video', path: media.path })}
        onRequestDetach={vi.fn()}
      />,
    );
  });
}

it('plays a readable large video through the existing raw reader and explains the collaboration limit', async () => {
  await render(413, 'too_large');
  const video = container.querySelector('video');
  expect(video).not.toBeNull();
  if (!video) throw new Error('The readable video must remain playable');
  const url = new URL(video.src);
  expect(url.pathname).toBe('/api/workspace/file/raw');
  expect(url.searchParams.get('worktreeId')).toBe('registered-video');
  expect(url.searchParams.get('path')).toBe('master.mp4');
  expect(video.controls).toBe(true);
  expect(container.textContent).toContain('文件太大');
  expect(container.textContent).toContain('批注');
  expect(container.textContent).not.toContain('正在打开作品');
  expect(container.textContent).not.toContain('开启协作');
  expect(container.textContent).not.toContain('原位置的文件暂时不可用');
});

it.each([
  [401, 'identity_required'],
  [403, 'access_denied'],
  [404, 'not_found'],
  [415, 'unsupported_media'],
] as const)('does not replace an owner refusal %s with a raw player', async (status, code) => {
  await render(status, code);
  expect(container.querySelector('video')).toBeNull();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});

it('keeps classic collaboration refusal behavior unchanged', async () => {
  writeShellPresentation('classic');
  await render(413, 'too_large');
  expect(container.querySelector('video')).toBeNull();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});

it.each([
  ['poster.png', 'image/png'],
  ['poster.jpg', 'image/jpeg'],
  ['poster.webp', 'image/webp'],
])('keeps the size refusal for %s instead of a raw image the owner cannot serve', async (path, mime) => {
  await render(413, 'too_large', { path, mime });
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('video')).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('超出了作品现场可打开的大小');
});
