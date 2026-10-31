// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '../../shell/shell-language';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { WorkspaceFocusExitButton } from '../WorkspaceFocusShell';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it('v2 keeps the labeled exit visible after three seconds, mouse leave and iframe focus', () => {
  writeShellPresentation('v2');
  const exit = vi.fn(),
    fullWindow = vi.fn();
  act(() =>
    root.render(
      <>
        <iframe title="预览页面" />
        <WorkspaceFocusExitButton onExit={exit} onFullWindow={fullWindow} />
      </>,
    ),
  );
  expect(host.querySelector('[data-testid="workspace-focus-controls"]')).not.toBeNull();
  expect(host.textContent).toContain('整窗');
  const iframe = host.querySelector('iframe');
  act(() => vi.advanceTimersByTime(3000));
  expect(host.querySelector('[data-testid="workspace-focus-controls"]')?.hasAttribute('hidden')).toBe(false);
  act(() => {
    host
      .querySelector('[role="toolbar"]')
      ?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    host.querySelector<HTMLButtonElement>('[data-testid="workspace-focus-exit"]')?.focus();
    iframe?.focus();
  });
  expect(document.activeElement).toBe(iframe);
  expect(host.querySelector('[data-testid="workspace-focus-controls"]')?.hasAttribute('hidden')).toBe(false);
  expect(host.querySelector('[data-testid="workspace-focus-top-edge"]')).toBeNull();
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="workspace-focus-full-window"]')?.click());
  expect(fullWindow).toHaveBeenCalledTimes(1);
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="workspace-focus-exit"]')?.click());
  expect(exit).toHaveBeenCalledTimes(1);
  expect(host.querySelector('iframe')).toBe(iframe);
});

it('classic retains its existing exit button and Escape behavior without the new controls', () => {
  writeShellPresentation('classic');
  const exit = vi.fn();
  act(() => root.render(<WorkspaceFocusExitButton onExit={exit} />));
  expect(host.querySelector('[data-testid="workspace-focus-exit"]')?.className).toContain('right-3');
  expect(host.querySelector('[data-testid="workspace-focus-controls"]')).toBeNull();
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(exit).toHaveBeenCalledTimes(1);
});

it('leaves full-window through the original toggle before leaving focus, with a reachable parent-document exit', () => {
  writeShellPresentation('v2');
  const exit = vi.fn();
  const fullWindow = vi.fn();
  act(() => root.render(<WorkspaceFocusExitButton onExit={exit} onFullWindow={fullWindow} fullWindow />));
  const leave = host.querySelector<HTMLButtonElement>('[aria-label="退出整窗"]');
  expect(leave).not.toBeNull();
  expect(host.querySelector('[data-testid="workspace-focus-full-window"]')).toBeNull();
  act(() => leave?.click());
  expect(fullWindow).toHaveBeenCalledTimes(1);
  expect(exit).not.toHaveBeenCalled();
  const keyEvent = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
  act(() => document.dispatchEvent(keyEvent));
  expect(keyEvent.defaultPrevented).toBe(true);
  expect(fullWindow).toHaveBeenCalledTimes(2);
  expect(exit).not.toHaveBeenCalled();
});

it('changes every v2 focus label with the shell language without remounting controls or replacing callbacks', () => {
  writeShellPresentation('v2');
  const exit = vi.fn();
  const fullWindow = vi.fn();
  act(() => root.render(<WorkspaceFocusExitButton onExit={exit} onFullWindow={fullWindow} />));
  const controls = host.querySelector('[data-testid="workspace-focus-controls"]');
  const leave = host.querySelector<HTMLButtonElement>('[data-testid="workspace-focus-exit"]');
  act(() => vi.advanceTimersByTime(2000));
  act(() => writeShellLanguage('en'));
  expect(host.querySelector('[role="toolbar"]')?.getAttribute('aria-label')).toBe('Focus controls');
  expect(leave?.getAttribute('aria-label')).toBe('Exit focus mode');
  expect(leave?.textContent).toContain('Exit focus');
  expect(host.querySelector('[data-testid="workspace-focus-full-window"]')?.textContent).toBe('Full window');
  expect(controls?.hasAttribute('hidden')).toBe(false);
  act(() => leave?.click());
  expect(exit).toHaveBeenCalledOnce();
  act(() => root.render(<WorkspaceFocusExitButton onExit={exit} onFullWindow={fullWindow} fullWindow />));
  expect(host.querySelector('[data-testid="workspace-focus-controls"]')).toBe(controls);
  expect(host.querySelector('[data-testid="workspace-focus-exit"]')).toBe(leave);
  expect(leave?.getAttribute('aria-label')).toBe('Exit full window');
  act(() => leave?.click());
  expect(fullWindow).toHaveBeenCalledOnce();
  expect(exit).toHaveBeenCalledOnce();
  act(() => writeShellLanguage('zh'));
  expect(host.querySelector('[role="toolbar"]')?.getAttribute('aria-label')).toBe('专注模式操作');
  expect(leave?.getAttribute('aria-label')).toBe('退出整窗');
});
