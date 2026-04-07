import fs from 'node:fs';
import path from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/* ---- Structural guard: every focusable pane must have an entry trigger ---- */
describe('WorkspacePanel focus entry coverage', () => {
  const PANE_TYPES = ['browser', 'file', 'terminal', 'git', 'changes'] as const;
  const src = fs.readFileSync(path.resolve(__dirname, '../WorkspacePanel.tsx'), 'utf-8');

  for (const pane of PANE_TYPES) {
    it(`has setFocusedPane('${pane}') entry trigger`, () => {
      expect(src).toContain(`setFocusedPane('${pane}')`);
    });
  }
});

/* ---- Mock heavy child components ---- */
vi.mock('@/components/workspace/BrowserPanel', () => ({
  BrowserPanel: (props: Record<string, unknown>) =>
    React.createElement('div', {
      'data-testid': 'browser-panel',
      'data-preview-only': String(!!props.previewOnly),
    }),
}));

/* ---- Tests: FocusModeButton ---- */
describe('FocusModeButton', () => {
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

  it('renders with default label', async () => {
    const { FocusModeButton } = await import('@/components/workspace/FocusModeButton');
    act(() => {
      root.render(React.createElement(FocusModeButton, { onClick: vi.fn() }));
    });
    const btn = container.querySelector('button')!;
    expect(btn.textContent).toBe('专注');
    expect(btn.disabled).toBe(false);
  });

  it('renders custom label', async () => {
    const { FocusModeButton } = await import('@/components/workspace/FocusModeButton');
    act(() => {
      root.render(React.createElement(FocusModeButton, { label: 'Focus', onClick: vi.fn() }));
    });
    expect(container.querySelector('button')!.textContent).toBe('Focus');
  });

  it('is disabled when prop is set', async () => {
    const onClick = vi.fn();
    const { FocusModeButton } = await import('@/components/workspace/FocusModeButton');
    act(() => {
      root.render(React.createElement(FocusModeButton, { disabled: true, onClick }));
    });
    const btn = container.querySelector('button')!;
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('calls onClick when clicked', async () => {
    const onClick = vi.fn();
    const { FocusModeButton } = await import('@/components/workspace/FocusModeButton');
    act(() => {
      root.render(React.createElement(FocusModeButton, { onClick }));
    });
    container.querySelector('button')!.click();
    expect(onClick).toHaveBeenCalledOnce();
  });
});

/* ---- Tests: WorkspaceFocusShell ---- */
describe('WorkspaceFocusShell', () => {
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

  it('renders children inside viewport', async () => {
    const { WorkspaceFocusShell } = await import('@/components/workspace/WorkspaceFocusShell');
    act(() => {
      root.render(
        React.createElement(
          WorkspaceFocusShell,
          { onExit: vi.fn() },
          React.createElement('div', { id: 'inner' }, 'hello'),
        ),
      );
    });
    const viewport = container.querySelector('[data-testid="workspace-focus-shell-viewport"]')!;
    expect(viewport.querySelector('#inner')!.textContent).toBe('hello');
  });

  it('calls onExit when exit button is clicked', async () => {
    const onExit = vi.fn();
    const { WorkspaceFocusShell } = await import('@/components/workspace/WorkspaceFocusShell');
    act(() => {
      root.render(React.createElement(WorkspaceFocusShell, { onExit }, 'content'));
    });
    // The exit button is in the sticky header
    const btn = container.querySelector('[data-testid="workspace-focus-shell"] button')!;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onExit).toHaveBeenCalledOnce();
  });

  it('calls onExit on Escape key', async () => {
    const onExit = vi.fn();
    const { WorkspaceFocusShell } = await import('@/components/workspace/WorkspaceFocusShell');
    act(() => {
      root.render(React.createElement(WorkspaceFocusShell, { onExit }, 'content'));
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onExit).toHaveBeenCalledOnce();
  });

  it('does not call onExit for non-Escape keys', async () => {
    const onExit = vi.fn();
    const { WorkspaceFocusShell } = await import('@/components/workspace/WorkspaceFocusShell');
    act(() => {
      root.render(React.createElement(WorkspaceFocusShell, { onExit }, 'content'));
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onExit).not.toHaveBeenCalled();
  });
});

/* ---- Tests: WorkspacePreviewOnly ---- */
describe('WorkspacePreviewOnly', () => {
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

  it('renders BrowserPanel with previewOnly inside focus shell', async () => {
    const { WorkspacePreviewOnly } = await import('@/components/workspace/WorkspacePreviewOnly');
    act(() => {
      root.render(
        React.createElement(WorkspacePreviewOnly, { initialPort: 3000, initialPath: '/app', onExit: vi.fn() }),
      );
    });
    // Should have focus shell wrapper
    expect(container.querySelector('[data-testid="workspace-focus-shell"]')).toBeTruthy();
    // BrowserPanel should be inside with previewOnly=true
    const bp = container.querySelector('[data-testid="browser-panel"]')!;
    expect(bp.getAttribute('data-preview-only')).toBe('true');
  });

  it('exit button in shell triggers onExit', async () => {
    const onExit = vi.fn();
    const { WorkspacePreviewOnly } = await import('@/components/workspace/WorkspacePreviewOnly');
    act(() => {
      root.render(React.createElement(WorkspacePreviewOnly, { initialPort: 3000, initialPath: '/', onExit }));
    });
    const btn = container.querySelector('[data-testid="workspace-focus-shell"] button')!;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onExit).toHaveBeenCalledOnce();
  });
});
