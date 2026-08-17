import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextualWorkspaceChrome } from '../ContextualWorkspaceChrome';

describe('F284 ContextualWorkspaceChrome', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
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

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('keeps one quiet shell header without duplicating the global Workspace fold control', async () => {
    await act(async () => {
      root.render(
        <ContextualWorkspaceChrome mode="workspace" onFold={() => {}}>
          <div data-testid="canonical-surface">canonical</div>
        </ContextualWorkspaceChrome>,
      );
    });

    expect(container.querySelector('[data-testid="canonical-surface"]')).not.toBeNull();
    for (const mode of ['workspace', 'status', 'transcript']) {
      expect(container.querySelector(`[data-testid="workspace-host-${mode}"]`)).toBeNull();
    }
    expect(container.querySelectorAll('[data-workspace-chrome-layer]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="workspace-shell-fold"]')).toBeNull();
    expect(container.textContent).not.toContain('工作动态伴随');
  });

  it('folds through the shell boundary', async () => {
    const onFold = vi.fn();
    await act(async () => {
      root.render(
        <ContextualWorkspaceChrome mode="status" onFold={onFold}>
          content
        </ContextualWorkspaceChrome>,
      );
    });

    const fold = container.querySelector('[data-testid="workspace-shell-fold"]');
    await act(async () => {
      fold?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onFold).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('状态与会话');
  });

  it('returns a nested status or meeting surface to the Workspace Launcher', async () => {
    const onNavigateHome = vi.fn();
    await act(async () => {
      root.render(
        <ContextualWorkspaceChrome mode="status" onFold={() => {}} onNavigateHome={onNavigateHome}>
          content
        </ContextualWorkspaceChrome>,
      );
    });

    const home = container.querySelector('[data-testid="workspace-shell-home"]');
    await act(async () => {
      home?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onNavigateHome).toHaveBeenCalledOnce();
  });
});
