import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Lightbox } from '@/components/Lightbox';
import { writeShellPresentation } from '@/components/shell/shell-presentation';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test', apiFetch: transport.fetch }));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  writeShellPresentation('classic');
  transport.fetch.mockImplementation(async () =>
    Response.json({
      local: true,
      path: '/isolated/uploads/original',
      canReveal: true,
      canOpen: true,
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it.each([
  'image',
  'video',
] as const)('the classic %s viewer exposes the same local actions through ⋯ and media context menu', async (mediaType) => {
  const close = vi.fn();
  await act(async () =>
    root.render(
      <Lightbox
        url={`/uploads/original.${mediaType === 'image' ? 'png' : 'mp4'}`}
        alt="Original"
        mediaType={mediaType}
        onClose={close}
      />,
    ),
  );
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  const more = dialog?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
  expect(more).not.toBeNull();
  await act(async () => more?.click());
  expect(document.querySelector('[role="menu"]')?.textContent).toMatch(/复制路径|Copy path/);
  expect(document.querySelector('[role="menu"]')?.textContent).toMatch(/Finder/);
  await act(async () =>
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(close).not.toHaveBeenCalled();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await act(async () =>
    dialog
      ?.querySelector('img,video')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })),
  );
  expect(document.querySelector('[role="menu"]')?.textContent).toMatch(/复制路径|Copy path/);
  expect(document.querySelector('[role="menu"]')?.textContent).toMatch(/默认应用|default application/);
});
