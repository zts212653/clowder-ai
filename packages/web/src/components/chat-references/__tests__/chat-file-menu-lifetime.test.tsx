import type { ChatFileReference } from '@cat-cafe/shared';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { ChatFileReferenceView } from '../ChatFileReferenceView';

const transport = vi.hoisted(() => ({ fetch: vi.fn(), copy: vi.fn(), open: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://file.test', apiFetch: transport.fetch }));
let host: HTMLDivElement, root: Root;
const target = (name: string): ChatFileReference => ({
  kind: 'file',
  entryType: 'file',
  worktreeId: 'original-tree',
  path: `docs/${name}.md`,
  absolutePath: `/original/docs/${name}.md`,
  line: null,
  mime: 'text/markdown',
  size: 42,
  modifiedAt: '2026-10-28T00:00:00Z',
});
function File({ name }: { name: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  return (
    <ChatFileReferenceView
      target={target(name)}
      layout="inline"
      anchor={anchor}
      onOpen={transport.open}
      error=""
      lightbox={null}
    />
  );
}
function Surface() {
  return (
    <>
      <textarea aria-label="Original draft" defaultValue="keep this draft" />
      <File name="one" />
      <File name="two" />
      <File name="three" />
      <button type="button">Outside</button>
    </>
  );
}
const files = () => [...host.querySelectorAll<HTMLElement>('[data-chat-reference-kind="file"]')];
const menus = () => [...host.querySelectorAll<HTMLElement>('[role="menu"]')];
async function pointer(element: HTMLElement, inside: boolean, related: EventTarget = document.body) {
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent(inside ? 'pointerenter' : 'pointerleave', { relatedTarget: related, bubbles: false }),
    );
    element.dispatchEvent(new MouseEvent(inside ? 'mouseover' : 'mouseout', { relatedTarget: related, bubbles: true }));
  });
}
async function settleLeave() {
  await act(async () => vi.advanceTimersByTimeAsync(200));
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  writeShellLanguage('en');
  transport.fetch.mockImplementation(async (url: string) =>
    Response.json({
      local: true,
      path: `/original/${new URL(url, 'http://file.test').searchParams.get('path')}`,
      byteLength: 42,
      mime: 'text/markdown',
    }),
  );
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: transport.copy } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Surface />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it('closes after leaving each file instead of accumulating menus and metadata reads', async () => {
  for (const file of files()) {
    await pointer(file, true);
    expect(menus()).toHaveLength(1);
    await pointer(file, false);
    await settleLeave();
    expect(menus()).toHaveLength(0);
  }
  expect(transport.fetch).toHaveBeenCalledTimes(3);
});

it('does not take focus or alter the mounted draft when a pointer previews file actions', async () => {
  const composer = host.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => composer.focus());
  await pointer(files()[0], true);
  expect(menus()).toHaveLength(1);
  expect(document.activeElement).toBe(composer);
  expect(composer.value).toBe('keep this draft');
  await pointer(files()[0], false);
  await settleLeave();
  expect(menus()).toHaveLength(0);
  expect(document.activeElement).toBe(composer);
});

it('keeps keyboard focus in an open menu after pointer exit and closes after focus also leaves', async () => {
  const file = files()[0];
  await pointer(file, true);
  const menu = menus()[0];
  await act(async () => menu.querySelector<HTMLButtonElement>('button')?.focus());
  await pointer(file, false);
  await settleLeave();
  expect(menus()).toHaveLength(1);
  expect(menu.contains(document.activeElement)).toBe(true);
  await act(async () => (host.lastElementChild as HTMLButtonElement).focus());
  await settleLeave();
  expect(menus()).toHaveLength(0);
});

it('does not open a competing hover menu while keyboard focus owns another file menu', async () => {
  const [first, second] = files();
  await act(async () => first.querySelector<HTMLButtonElement>('button')?.focus());
  await act(async () =>
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true })),
  );
  const focusedMenu = menus()[0];
  expect(focusedMenu.contains(document.activeElement)).toBe(true);
  await pointer(first, false);
  await pointer(second, true);
  await settleLeave();
  expect(menus()).toEqual([focusedMenu]);
  expect(focusedMenu.contains(document.activeElement)).toBe(true);
});

it('allows crossing into the menu and performs the original file action before dismissing it', async () => {
  const file = files()[0];
  await pointer(file, true);
  const menu = menus()[0];
  await pointer(file, false, menu);
  await pointer(menu, true, file);
  await settleLeave();
  expect(menus()).toHaveLength(1);
  const copy = [...menu.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Copy path',
  );
  expect(copy).toBeDefined();
  await act(async () => copy!.click());
  await settleLeave();
  expect(transport.copy).toHaveBeenCalledWith('/original/docs/one.md');
  expect(menus()).toHaveLength(0);
  expect(transport.open).not.toHaveBeenCalled();
});

it.each([
  'ContextMenu',
  'Shift+F10',
])('opens with %s, restores the file focus on Escape and can reopen', async (shortcut) => {
  const button = files()[0].querySelector<HTMLButtonElement>('button')!;
  await act(async () => button.focus());
  for (let attempt = 0; attempt < 2; attempt++) {
    await act(async () =>
      button.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: shortcut === 'ContextMenu' ? 'ContextMenu' : 'F10',
          shiftKey: shortcut !== 'ContextMenu',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    const menu = menus()[0];
    expect(menu).toBeDefined();
    expect(menu.contains(document.activeElement)).toBe(true);
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      ),
    );
    await settleLeave();
    expect(menus()).toHaveLength(0);
    expect(document.activeElement).toBe(button);
  }
});

it('dismisses on an outside pointer and does not reopen on an unrelated parent render', async () => {
  await pointer(files()[0], true);
  await act(async () => host.lastElementChild!.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  await act(async () => root.render(<Surface />));
  await settleLeave();
  expect(menus()).toHaveLength(0);
  expect(transport.fetch).toHaveBeenCalledTimes(1);
});

it('does not reopen or move focus when delayed metadata arrives after dismissal', async () => {
  let answer!: (value: Response) => void;
  transport.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  );
  await pointer(files()[0], true);
  await pointer(files()[0], false);
  await settleLeave();
  await act(async () => answer(Response.json({ local: true, path: '/original/docs/one.md' })));
  expect(menus()).toHaveLength(0);
  expect(transport.fetch).toHaveBeenCalledTimes(1);
});
