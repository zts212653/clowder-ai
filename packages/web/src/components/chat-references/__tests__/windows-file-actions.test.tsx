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
