import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_MODES } from '@/lib/workspace-modes';

const mocks = vi.hoisted(() => ({
  workspaceMode: 'dev',
  setWorkspaceMode: vi.fn(),
}));

vi.mock('../../ChatVoiceFeatureControls', () => ({
  ChatVoiceFeatureControls: () => <div data-testid="workspace-companion-controls">陪伴入口</div>,
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      workspaceMode: mocks.workspaceMode,
      setWorkspaceMode: mocks.setWorkspaceMode,
    }),
}));

import { WorkspaceLauncher } from '../WorkspaceLauncher';

describe('F284 WorkspaceLauncher', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.workspaceMode = 'dev';
    mocks.setWorkspaceMode.mockReset();
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

  async function renderLauncher() {
    await act(async () => {
      root.render(<WorkspaceLauncher />);
    });
  }

  it('is the always-visible first screen rather than a second-step popover', async () => {
    await renderLauncher();

    expect(container.textContent).toContain('你想打开什么？');
    expect(container.querySelector('[data-testid="workspace-launcher-trigger"]')).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-launcher-home"]')).not.toBeNull();
  });

  it('projects every canonical destination into human-readable groups', async () => {
    await renderLauncher();

    expect(container.textContent).toContain('现在要做什么');
    expect(container.textContent).toContain('组织工作');
    expect(container.textContent).toContain('回看与理解');

    for (const mode of WORKSPACE_MODES.filter((mode) => mode !== 'dev')) {
      expect(container.querySelector(`[data-testid="workspace-launcher-${mode}"]`)).not.toBeNull();
    }
    expect(container.querySelector('[data-testid="workspace-launcher-dev"]')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-launcher-dev-files"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="workspace-launcher-dev-browser"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="workspace-launcher-status"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="workspace-companion-controls"]')).not.toBeNull();
  });

  it('opens status and session diagnostics from the Launcher instead of permanent header chrome', async () => {
    const onOpenStatus = vi.fn();
    await act(async () => {
      root.render(<WorkspaceLauncher onOpenStatus={onOpenStatus} />);
    });

    const status = container.querySelector('[data-testid="workspace-launcher-status"]');
    await act(async () => {
      status?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onOpenStatus).toHaveBeenCalledOnce();
  });

  it('lets the panel width choose one or two columns instead of the viewport breakpoint', async () => {
    await renderLauncher();

    const grids = container.querySelectorAll<HTMLElement>('[data-testid="workspace-launcher-grid"]');
    expect(grids.length).toBeGreaterThan(0);
    for (const grid of grids) {
      expect(grid.dataset.layout).toBe('panel-auto-fit');
      expect(grid.className).not.toContain('xl:grid-cols-2');
    }
  });

  it('searches capability labels without adding permanent filters', async () => {
    await renderLauncher();
    const search = container.querySelector<HTMLInputElement>('[data-testid="workspace-launcher-search"]');

    await act(async () => {
      if (!search) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(search, '评估');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="workspace-launcher-eval"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="workspace-launcher-dev"]')).toBeNull();
  });

  it('routes selection through the canonical store action', async () => {
    await renderLauncher();
    const item = container.querySelector('[data-testid="workspace-launcher-recall"]');

    await act(async () => {
      item?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.setWorkspaceMode).toHaveBeenCalledWith('recall');
  });

  it('routes development tools without restoring the permanent mode tab row', async () => {
    const onSelectDevSurface = vi.fn();
    await act(async () => {
      root.render(<WorkspaceLauncher onSelectDevSurface={onSelectDevSurface} />);
    });

    const browser = container.querySelector('[data-testid="workspace-launcher-dev-browser"]');
    await act(async () => {
      browser?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.setWorkspaceMode).toHaveBeenCalledWith('dev');
    expect(onSelectDevSurface).toHaveBeenCalledWith('browser');
    expect(container.querySelector('[data-testid="workspace-dev-mode-tabs"]')).toBeNull();
  });
});
