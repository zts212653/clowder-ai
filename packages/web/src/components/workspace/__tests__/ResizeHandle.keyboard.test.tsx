import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResizeHandle } from '../ResizeHandle';

Object.assign(globalThis, { React });

describe('ResizeHandle keyboard ownership', () => {
  let container: HTMLDivElement;
  let root: Root;
  const globalShortcut = vi.fn();

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    globalShortcut.mockReset();
    window.addEventListener('keydown', globalShortcut);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.removeEventListener('keydown', globalShortcut);
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function press(key: string) {
    const separator = container.querySelector('[role="separator"]');
    expect(separator).toBeTruthy();
    act(() => separator?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
  }

  it('resizes with its handled arrow without also advancing a window-level player shortcut', () => {
    const onResize = vi.fn();
    act(() => root.render(<ResizeHandle direction="horizontal" onResize={onResize} />));
    press('ArrowRight');
    expect(onResize).toHaveBeenCalledExactlyOnceWith(16);
    expect(globalShortcut).not.toHaveBeenCalled();
  });

  it('collapses with Space without also toggling a window-level player shortcut', () => {
    const onCollapse = vi.fn();
    act(() => root.render(<ResizeHandle direction="horizontal" onResize={vi.fn()} onCollapse={onCollapse} />));
    press(' ');
    expect(onCollapse).toHaveBeenCalledOnce();
    expect(globalShortcut).not.toHaveBeenCalled();
  });

  it('lets an unhandled Escape reach the existing global exit owner', () => {
    const onResize = vi.fn();
    act(() => root.render(<ResizeHandle direction="horizontal" onResize={onResize} />));
    press('Escape');
    expect(onResize).not.toHaveBeenCalled();
    expect(globalShortcut).toHaveBeenCalledOnce();
  });

  it('does not consume Space when this separator has no collapse action', () => {
    act(() => root.render(<ResizeHandle direction="vertical" onResize={vi.fn()} />));
    press(' ');
    expect(globalShortcut).toHaveBeenCalledOnce();
  });
});
