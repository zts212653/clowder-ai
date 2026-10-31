// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { V2WorkspaceMenu } from '../V2WorkspaceMenu';
import { workspaceMenuPosition } from '../workspace-menu-position';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
function openMenu() {
  act(() => {
    const details = host.querySelector('details');
    if (!details) throw new Error('missing native disclosure');
    const summary = details.querySelector('summary');
    if (!summary) throw new Error('missing trigger');
    vi.spyOn(summary, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 40, 32)] as unknown as DOMRectList);
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
}

it('keeps listening content mounted through repeated open/close', () => {
  const mount = vi.fn(),
    unmount = vi.fn();
  function ListeningContent() {
    useEffect(() => {
      mount();
      return unmount;
    }, []);
    return <button type="button">Listen</button>;
  }
  act(() =>
    root.render(
      <V2WorkspaceMenu trigger="More" triggerProps={{}} width={256}>
        <ListeningContent />
      </V2WorkspaceMenu>,
    ),
  );
  expect(mount).toHaveBeenCalledTimes(1);
  const panel = document.querySelector<HTMLElement>('[data-v2-workspace-menu]');
  expect(panel?.hidden).toBe(true);
  openMenu();
  expect(panel?.hidden).toBe(false);
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(panel?.hidden).toBe(true);
  expect(host.querySelector('details')?.open).toBe(false);
  expect(document.activeElement).toBe(host.querySelector('summary'));
  openMenu();
  expect(mount).toHaveBeenCalledTimes(1);
  expect(unmount).not.toHaveBeenCalled();
});

it('keeps popup input inside the dismissal boundary, but closes on outside pointer', () => {
  act(() =>
    root.render(
      <V2WorkspaceMenu trigger="More" triggerProps={{}} width={256}>
        <button type="button">Action</button>
      </V2WorkspaceMenu>,
    ),
  );
  openMenu();
  const panel = document.querySelector('[data-v2-workspace-menu]');
  act(() => panel?.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(host.querySelector('details')?.open).toBe(true);
  act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(host.querySelector('details')?.open).toBe(false);
});

it('places keyboard focus on a visible action instead of a responsive hidden duplicate', () => {
  act(() =>
    root.render(
      <V2WorkspaceMenu trigger="More" triggerProps={{}} width={160}>
        <span hidden>
          <button type="button">Hidden duplicate</button>
        </span>
        <button type="button">Edit</button>
      </V2WorkspaceMenu>,
    ),
  );
  const edit = Array.from(document.querySelectorAll('button')).find((node) => node.textContent === 'Edit');
  if (!edit) throw new Error('missing visible action');
  vi.spyOn(edit, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 100, 32)] as unknown as DOMRectList);
  openMenu();
  expect(document.activeElement).toBe(edit);
});

it('clamps both viewport edges and flips tall menus above bottom triggers', () => {
  for (const left of [-30, 0, 180, 700]) {
    const boundary = { left, right: left + 320, top: 0, bottom: 720 };
    const anchor = { left: left + 10, right: left + 60, top: 650, bottom: 680 };
    const result = workspaceMenuPosition(anchor, boundary, { width: 1000, height: 720 }, 256, 234);
    expect(result.left).toBeGreaterThanOrEqual(Math.max(8, left));
    expect(result.left + result.width).toBeLessThanOrEqual(Math.min(992, boundary.right));
    expect(result.top).toBeGreaterThanOrEqual(8);
    expect(result.top + Math.min(result.maxHeight, 234)).toBeLessThanOrEqual(anchor.top);
  }
});

it('dismisses a portal when its Workspace trigger is hidden', () => {
  act(() =>
    root.render(
      <V2WorkspaceMenu trigger="More" triggerProps={{}} width={160}>
        <button type="button">Edit</button>
      </V2WorkspaceMenu>,
    ),
  );
  openMenu();
  const summary = host.querySelector('summary');
  if (!summary) throw new Error('missing trigger');
  vi.spyOn(summary, 'getClientRects').mockReturnValue([] as unknown as DOMRectList);
  act(() => window.dispatchEvent(new Event('resize')));
  expect(host.querySelector('details')?.open).toBe(false);
  expect(document.querySelector<HTMLElement>('[data-v2-workspace-menu]')?.hidden).toBe(true);
});

it('opens one return generation, focuses its input, and never reopens the dismissed generation', () => {
  const render = (request?: number) =>
    act(() =>
      root.render(
        <V2WorkspaceMenu
          trigger="+"
          triggerProps={{}}
          width={256}
          {...{ openRequest: request, focusSelector: '[data-return-input]' }}
        >
          <button type="button">Other tool</button>
          <input data-return-input="" />
        </V2WorkspaceMenu>,
      ),
    );
  render();
  const trigger = host.querySelector('summary');
  const input = document.querySelector<HTMLInputElement>('[data-return-input]');
  if (!trigger || !input) throw new Error('the real menu nodes must be mounted');
  vi.spyOn(trigger, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 40, 32)] as unknown as DOMRectList);
  vi.spyOn(input, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 120, 32)] as unknown as DOMRectList);
  render(1);
  expect(host.querySelector('details')?.open).toBe(true);
  expect(document.activeElement).toBe(input);
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  render(1);
  expect(host.querySelector('details')?.open).toBe(false);
  expect(document.activeElement).toBe(trigger);
  render(2);
  expect(host.querySelector('details')?.open).toBe(true);
  expect(document.activeElement).toBe(input);
});
