import type { ChatFileReference } from '@cat-cafe/shared';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { FileActions } from '../../content-review/FileActions';
import { ChatFileReferenceView } from '../ChatFileReferenceView';

const transport = vi.hoisted(() => ({ fetch: vi.fn(), copy: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://file.test', apiFetch: transport.fetch }));
let host: HTMLDivElement, root: Root;
const source = { kind: 'workspace' as const, worktreeId: 'tree', path: 'docs/report.md' };
const windowsPath = 'C:\\demo\\project with spaces\\docs\\report.md';
function Reference({ absolutePath, layout = 'inline' }: { absolutePath: string; layout?: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const target: ChatFileReference = {
    ...source,
    kind: 'file',
    entryType: 'file',
    absolutePath,
    line: null,
    mime: 'text/markdown',
    size: 42,
    modifiedAt: '2026-11-03T00:00:00Z',
  };
  return (
    <ChatFileReferenceView target={target} layout={layout} anchor={anchor} onOpen={() => {}} error="" lightbox={null} />
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  writeShellLanguage('en');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: transport.copy } });
  transport.fetch.mockImplementation(async () =>
    Response.json({ local: true, path: windowsPath, canOpen: false, canReveal: false }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it.each([
  windowsPath,
  'D:/project/docs/report.md',
  '/home/user/docs/report.md',
  '\\\\server\\share\\docs\\report.md',
])('shows the filename in the chat link and menu while copying the original path: %s', async (absolutePath) => {
  transport.fetch.mockImplementation(async () =>
    Response.json({ local: true, path: absolutePath, canOpen: false, canReveal: false }),
  );
  await act(async () => root.render(<Reference absolutePath={absolutePath} />));
  const file = host.querySelector<HTMLElement>('[data-chat-reference-kind="file"]')!;
  expect(file.textContent).toBe('report.md');
  expect(file.title).toBe(absolutePath);
  await act(async () => file.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  const menu = host.querySelector('[role="menu"]')!;
  expect(menu.querySelector('strong')?.textContent).toBe('report.md');
  expect(menu.textContent).toContain(absolutePath);
  expect(menu.textContent).toContain('Local open and reveal are unavailable');
  expect(menu.textContent).not.toContain('Show in Finder');
  expect(menu.textContent).not.toContain('Open with default application');
  const copy = [...menu.querySelectorAll('button')].find((button) => button.textContent === 'Copy path')!;
  expect(copy.disabled).toBe(false);
  await act(async () => copy.click());
  expect(transport.copy).toHaveBeenCalledWith(absolutePath);
});

it('keeps the Windows directory separate from the filename in a file card', async () => {
  await act(async () => root.render(<Reference absolutePath={windowsPath} layout="card" />));
  expect(host.querySelector('[data-chat-file-name]')?.textContent).toBe('report.md');
  expect(host.textContent).toContain('C:\\demo\\project with spaces\\docs\\');
});

it('preserves home metadata filename when the selected version differs from the link label', async () => {
  transport.fetch.mockResolvedValue(
    Response.json({
      local: true,
      path: windowsPath,
      filename: 'published-version.md',
      canOpen: false,
      canReveal: false,
    }),
  );
  await act(async () => root.render(<Reference absolutePath={windowsPath} />));
  const file = host.querySelector<HTMLElement>('[data-chat-reference-kind="file"]')!;
  await act(async () => file.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  const menu = host.querySelector('[role="menu"]')!;
  expect(menu.querySelector('strong')?.textContent).toBe('published-version.md');
  const copy = [...menu.querySelectorAll('button')].find((button) => button.textContent === 'Copy path')!;
  await act(async () => copy.click());
  expect(transport.copy).toHaveBeenCalledWith(windowsPath);
});

it('preserves home unavailable-original reason without advertising native actions', async () => {
  transport.fetch.mockResolvedValue(
    Response.json({ local: false, canOpen: false, canReveal: false, reason: 'native_original_unavailable' }),
  );
  await act(async () => root.render(<Reference absolutePath={windowsPath} />));
  const file = host.querySelector<HTMLElement>('[data-chat-reference-kind="file"]')!;
  await act(async () => file.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  const menu = host.querySelector('[role="menu"]')!;
  expect(menu.querySelector('[role="status"]')?.textContent).toBe('native_original_unavailable');
  expect(menu.textContent).not.toContain('Show in Finder');
  expect(menu.textContent).not.toContain('Open with default application');
});

it.each([
  ['inline', 'notes\\draft.md'],
  ['card', 'notes\\draft.md'],
  ['card', 'notes\\'],
])('preserves a literal POSIX backslash in the %s name and menu: %s', async (layout, filename) => {
  const absolutePath = `/tmp/docs/${filename}`;
  transport.fetch.mockResolvedValue(Response.json({ local: true, path: absolutePath }));
  await act(async () => root.render(<Reference absolutePath={absolutePath} layout={layout} />));
  const file = host.querySelector<HTMLElement>('[data-chat-reference-kind="file"]')!;
  expect.soft(file.querySelector('[data-chat-file-name], [class*="filename"]')?.textContent).toBe(filename);
  if (layout === 'card') expect.soft(file.querySelector('[class*="directory"]')?.textContent).toBe('/tmp/docs/');
  await act(async () => file.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  const menu = host.querySelector('[role="menu"]')!;
  expect(menu.querySelector('strong')?.textContent).toBe(filename);
  const copy = [...menu.querySelectorAll('button')].find((button) => button.textContent === 'Copy path')!;
  await act(async () => copy.click());
  expect(transport.copy).toHaveBeenCalledWith(absolutePath);
});

it.each(['failure', 'success'])('keeps newer metadata when an older read finishes with %s', async (olderResult) => {
  let finishOlder!: (response: Response) => void;
  let failOlder!: (error: Error) => void;
  transport.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve, reject) => {
        finishOlder = resolve;
        failOlder = reject;
      }),
  );
  transport.fetch.mockResolvedValueOnce(Response.json({ local: true, path: windowsPath, author: 'New snapshot' }));
  await act(async () => root.render(<FileActions source={source} filename="report.md" appearance="classic" />));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
  expect(transport.fetch).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[role="menu"]')?.textContent).toContain('New snapshot');
  await act(async () => {
    if (olderResult === 'failure') failOlder(new Error('late failure'));
    else finishOlder(Response.json({ local: true, path: windowsPath, author: 'Old snapshot' }));
  });
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector('[role="menu"]')?.textContent).toContain('New snapshot');
  const copy = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Copy path')!;
  expect(copy.disabled).toBe(false);
  await act(async () => copy.click());
  expect(transport.copy).toHaveBeenCalledWith(windowsPath);
});

it('keeps the newer read failure when an older read later succeeds', async () => {
  let finishOlder!: (response: Response) => void;
  transport.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finishOlder = resolve;
      }),
  );
  transport.fetch.mockRejectedValueOnce(new Error('current failure'));
  await act(async () => root.render(<FileActions source={source} filename="report.md" appearance="classic" />));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => finishOlder(Response.json({ local: true, path: windowsPath })));
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  const copy = host.querySelector<HTMLButtonElement>('button')!;
  expect(copy.disabled).toBe(true);
});

it.each([
  'failure',
  'success',
])('ignores an old file read that finishes with %s after selection changes', async (result) => {
  let finishOlder!: (response: Response) => void;
  let failOlder!: (error: Error) => void;
  transport.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve, reject) => {
        finishOlder = resolve;
        failOlder = reject;
      }),
  );
  const nextPath = 'C:\\demo\\docs\\next.md';
  transport.fetch.mockResolvedValueOnce(Response.json({ local: true, path: nextPath }));
  await act(async () => root.render(<FileActions source={source} filename="report.md" appearance="classic" />));
  await act(async () =>
    root.render(<FileActions source={{ ...source, path: 'docs/next.md' }} filename="next.md" appearance="classic" />),
  );
  await act(async () => {
    if (result === 'failure') failOlder(new Error('old file unavailable'));
    else finishOlder(Response.json({ local: true, path: windowsPath }));
  });
  expect(host.querySelector('[role="alert"]')).toBeNull();
  const copy = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Copy path')!;
  expect(copy.disabled).toBe(false);
  await act(async () => copy.click());
  expect(transport.copy).toHaveBeenCalledWith(nextPath);
});

it('stops loading after a metadata failure and retries in the same shared menu', async () => {
  transport.fetch.mockRejectedValueOnce(new Error('offline'));
  await act(async () => root.render(<FileActions source={source} filename="report.md" />));
  await act(async () => host.querySelector('button')!.click());
  const menu = host.querySelector('[role="menu"]')!;
  expect(menu.textContent).not.toContain('Reading file information');
  expect(menu.querySelector('[role="alert"]')?.textContent).toContain('Could not read file information');
  const retry = [...menu.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!;
  expect(retry).toBeDefined();
  await act(async () => retry.click());
  expect(transport.fetch).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[role="menu"]')).toBe(menu);
  expect(menu.querySelector('[role="alert"]')).toBeNull();
  expect(menu.textContent).toContain(windowsPath);
  expect(menu.textContent).toContain('Copy path');
});

it('shows a persistent metadata error and retries directly in the classic file toolbar', async () => {
  transport.fetch.mockRejectedValueOnce(new Error('offline'));
  await act(async () => root.render(<FileActions source={source} filename="report.md" appearance="classic" />));
  expect(host.querySelector('[role="menu"]')).toBeNull();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not read file information');
  const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!;
  expect(retry).toBeDefined();
  await act(async () => retry.click());
  expect(transport.fetch).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector('[role="menu"]')).toBeNull();
  const copy = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Copy path')!;
  expect(copy.disabled).toBe(false);
  await act(async () => copy.click());
  expect(transport.copy).toHaveBeenCalledWith(windowsPath);
});
