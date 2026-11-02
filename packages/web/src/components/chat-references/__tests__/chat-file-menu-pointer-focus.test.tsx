import type { ChatFileReference } from '@cat-cafe/shared';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FileActions } from '@/components/content-review/FileActions';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { ChatFileReferenceView } from '../ChatFileReferenceView';

const transport = vi.hoisted(() => ({ fetch: vi.fn(), copy: vi.fn(), open: vi.fn() }));
let host: HTMLDivElement, root: Root, keyboardFocus: boolean;
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://file.test', apiFetch: transport.fetch }));
const target: ChatFileReference = {
  kind: 'file',
  entryType: 'file',
  worktreeId: 'original-tree',
  path: 'docs/one.md',
  absolutePath: '/original/docs/one.md',
  line: null,
  mime: 'text/markdown',
  size: 42,
  modifiedAt: '2026-10-28T00:00:00Z',
};
function Chip() {
  const anchor = useRef<HTMLSpanElement>(null);
  return (
    <ChatFileReferenceView
      target={target}
      layout="inline"
      anchor={anchor}
      onOpen={transport.open}
      error=""
      lightbox={null}
    />
  );
}
function Explicit({ openOnHover = false, visible = true }: { openOnHover?: boolean; visible?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} id="explicit">
      <FileActions
        source={{ kind: 'workspace', worktreeId: 'original-tree', path: 'docs/one.md' }}
        filename="one.md"
        contextRef={ref}
        openOnHover={openOnHover}
        visible={visible}
      />
    </div>
  );
}
function Surface() {
  return (
    <>
      <textarea aria-label="Original draft" defaultValue="keep this draft" />
      <Chip />
      <button type="button" id="outside">
        Outside
      </button>
      <Explicit />
    </>
  );
}
const file = () => host.querySelector<HTMLElement>('[data-chat-reference-kind="file"]')!;
const button = () => file().querySelector<HTMLButtonElement>(':scope > button')!;
const menus = () => [...host.querySelectorAll<HTMLElement>('[role="menu"]')];
const settle = async (ms = 200) => act(async () => vi.advanceTimersByTimeAsync(ms));
async function pointer(inside: boolean, pointerType = 'mouse', owner = file()) {
  await act(async () => {
    const event = new MouseEvent(inside ? 'pointerenter' : 'pointerleave', { relatedTarget: document.body });
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    owner.dispatchEvent(event);
  });
}
async function mouseClick(element: HTMLElement) {
  keyboardFocus = false;
  await act(async () => element.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  await act(async () => element.focus());
  await act(async () => element.click());
}
async function keyboardFocusChip() {
  keyboardFocus = true;
  await act(async () => button().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
  await act(async () => button().focus());
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  writeShellLanguage('en');
  keyboardFocus = true;
  // jsdom does not model browser input modality. Only this platform pseudo-class
  // is supplied; the actual focus, menu, events and timers remain real DOM state.
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector) {
    return selector === ':focus-visible'
      ? keyboardFocus && this === document.activeElement
      : matches.call(this, selector);
  });
  transport.fetch.mockResolvedValue(
    Response.json({ local: true, path: '/original/docs/one.md', byteLength: 42, mime: 'text/markdown' }),
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
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it('does not reopen or reread after clicking a hovered file gives its button pointer focus', async () => {
  await pointer(true);
  expect(menus()).toHaveLength(1);
  await mouseClick(button());
  expect(document.activeElement).toBe(button());
  expect(transport.open).toHaveBeenCalledTimes(1);
  expect(menus()).toHaveLength(0);
  expect(transport.fetch).toHaveBeenCalledTimes(1);
});

it('closes a later hover even when mouse focus remains on the file button', async () => {
  await pointer(true);
  await mouseClick(button());
  await pointer(false);
  await settle();
  await pointer(true);
  expect(menus()).toHaveLength(1);
  await pointer(false);
  await settle(1000);
  expect(document.activeElement).toBe(button());
  expect(menus()).toHaveLength(0);
});

it('does not pin a later hover to the focus restored after a mouse menu action', async () => {
  await pointer(true);
  const copy = [...menus()[0].querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent === 'Copy path',
  )!;
  await mouseClick(copy);
  expect(transport.copy).toHaveBeenCalledWith('/original/docs/one.md');
  expect(document.activeElement).toBe(button());
  await pointer(false);
  await settle();
  await pointer(true);
  await pointer(false);
  await settle(1000);
  expect(menus()).toHaveLength(0);
});

it('previews on keyboard focus without stealing it and keeps that menu until keyboard focus leaves', async () => {
  await keyboardFocusChip();
  expect(menus()).toHaveLength(1);
  expect(document.activeElement).toBe(button());
  await pointer(false);
  await settle(500);
  expect(menus()).toHaveLength(1);
  await act(async () => host.querySelector<HTMLButtonElement>('#outside')!.focus());
  await settle();
  expect(menus()).toHaveLength(0);
});

it.each([
  { openOnHover: false, visible: true },
  { openOnHover: true, visible: false },
])('does not hover-open an explicit or hidden host: %j', async (props) => {
  await act(async () => root.render(<Explicit {...props} />));
  await pointer(true, 'mouse', host.querySelector<HTMLElement>('#explicit')!);
  await settle(400);
  expect(menus()).toHaveLength(0);
  expect(transport.fetch).not.toHaveBeenCalled();
});

it('leaves a grace period for crossing into the menu but closes by 200ms', async () => {
  await pointer(true);
  await pointer(false);
  await settle(100);
  expect(menus()).toHaveLength(1);
  await settle(100);
  expect(menus()).toHaveLength(0);
});

it('cancels the pending close on pointer reentry without reading metadata twice', async () => {
  await pointer(true);
  const first = menus()[0];
  await pointer(false);
  await settle(100);
  await pointer(true);
  await settle(400);
  expect(menus()).toEqual([first]);
  expect(transport.fetch).toHaveBeenCalledTimes(1);
});

it('ignores touch pointer hover instead of opening another menu', async () => {
  await pointer(true, 'touch');
  await settle(400);
  expect(menus()).toHaveLength(0);
  expect(transport.fetch).not.toHaveBeenCalled();
});

it('keeps pointer ownership when keyboard focus leaves the chip', async () => {
  await pointer(true);
  await keyboardFocusChip();
  await act(async () => host.querySelector<HTMLTextAreaElement>('textarea')!.focus());
  await settle(600);
  expect(menus()).toHaveLength(1);
});

it('swallows owner Escape only while its menu is open', async () => {
  await keyboardFocusChip();
  const first = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  await act(async () => button().dispatchEvent(first));
  expect(first.defaultPrevented).toBe(true);
  expect(menus()).toHaveLength(0);
  const second = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  await act(async () => button().dispatchEvent(second));
  expect(second.defaultPrevented).toBe(false);
});

it('supports the common owner shortcut and restores focus to an explicit trigger', async () => {
  const explicit = host.querySelector<HTMLElement>('#explicit')!;
  const trigger = explicit.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  await act(async () => trigger.focus());
  await act(async () =>
    explicit.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }),
    ),
  );
  expect(menus()).toHaveLength(1);
  expect(menus()[0].contains(document.activeElement)).toBe(true);
  await act(async () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    ),
  );
  expect(menus()).toHaveLength(0);
  expect(document.activeElement).toBe(trigger);
});
