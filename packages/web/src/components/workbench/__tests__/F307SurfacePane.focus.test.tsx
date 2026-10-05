import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { F307SurfacePane } from '../F307SurfacePane';
import type { WorkspaceSurfaceDescriptor } from '../workbench-contract';

const SURFACE: WorkspaceSurfaceDescriptor = {
  id: 'browser:chess',
  type: 'browser',
  renderer: 'browser-preview',
  title: '象棋',
  context: 'localhost:3147',
  objectRef: { kind: 'preview-session', id: 'chess' },
  ownerStateRef: { owner: 'f120-browser-preview', key: 'chess' },
  resultTargetRef: { owner: 'f120-browser-preview', key: '3147:/' },
  capabilities: {
    split: true,
    sidecar: true,
    pin: true,
    closePolicy: 'detach-host',
    restorePolicy: 'descriptor',
  },
};

describe('F307 surface focus mode', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps the owner DOM mounted while hiding and restoring the pane chrome', () => {
    const enter = vi.fn();
    const exit = vi.fn();
    const owner = <div data-testid="chess-owner">棋盘</div>;

    act(() =>
      root.render(
        <F307SurfacePane surface={SURFACE} focusMode={false} onEnterFocusMode={enter} onExitFocusMode={exit}>
          {owner}
        </F307SurfacePane>,
      ),
    );
    const ownerNode = container.querySelector('[data-testid="chess-owner"]');
    const entry = container.querySelector<HTMLButtonElement>('[data-testid="workspace-focus-enter"]');
    expect(entry?.textContent).toContain('专注');
    act(() => entry?.click());
    expect(enter).toHaveBeenCalledOnce();

    act(() =>
      root.render(
        <F307SurfacePane surface={SURFACE} focusMode onEnterFocusMode={enter} onExitFocusMode={exit}>
          {owner}
        </F307SurfacePane>,
      ),
    );

    expect(container.querySelector('[data-testid="f307-surface-chrome"]')).toBeNull();
    expect(container.querySelector('[data-testid="chess-owner"]')).toBe(ownerNode);
    const exitButton = container.querySelector<HTMLButtonElement>('[data-testid="workspace-focus-exit"]');
    expect(exitButton?.textContent).toContain('退出专注');
    act(() => exitButton?.click());
    expect(exit).toHaveBeenCalledOnce();
  });
});
